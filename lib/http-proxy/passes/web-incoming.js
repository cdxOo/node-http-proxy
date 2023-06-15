'use strict'
// vim: shiftwidth=2
var followRedirectAgents = require('follow-redirects');
var nativeAgents = { http: require('http'), https: require('https') };
var common = require('../common');
var web_o  = require('./web-outgoing');

var getProtoAgent = (agents, proto) => (
  proto === 'https:' ? agents.https : agents.http
)

var createErrorHandler = (bag) => {
  var {
    server, request, response,
    outgoingRequest, parsedUrl, callback
  } = bag;
  var extraArgs = [ request, response, parsedUrl ];

  return (err) => {
      if (request.socket.destroyed && err.code === 'ECONNRESET') {
        server.emit('econnreset', err, ...extraArgs);
        return outgoingRequest.abort();
      }

      if (callback) {
        callback(err, ...extraArgs);
      } else {
        server.emit('error', err, ...extraArgs);
      }
  }
}

web_o = Object.keys(web_o).map(function(pass) {
  return web_o[pass];
});

/*!
 * Array of passes.
 *
 * A `pass` is just a function that is executed on `req, res, options`
 * so that you can easily add new checks while still keeping the base
 * flexible.
 */


var passesByName = {

  /**
   * Sets `content-length` to '0' if request is of DELETE type.
   *
   * @param {ClientRequest} Req Request object
   * @param {IncomingMessage} Res Response object
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  deleteLength: (req, res, options) => {
    if(
      (req.method === 'DELETE' || req.method === 'OPTIONS')
       && !req.headers['content-length']
    ) {
      req.headers['content-length'] = '0';
      delete req.headers['transfer-encoding'];
    }
  },

  /**
   * Sets timeout in request socket if it was specified in options.
   *
   * @param {ClientRequest} Req Request object
   * @param {IncomingMessage} Res Response object
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  timeout: (req, res, options) => {
    if (options.timeout) {
      req.socket.setTimeout(options.timeout);
    }
  },

  /**
   * Sets `x-forwarded-*` headers if specified in config.
   *
   * @param {ClientRequest} Req Request object
   * @param {IncomingMessage} Res Response object
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  XHeaders: (req, res, options) => {
    if (!options.xfwd) return;

    var encrypted = req.isSpdy || common.hasEncryptedConnection(req);
    var values = {
      for: req.connection.remoteAddress || req.socket.remoteAddress,
      port: common.getPort(req),
      proto: encrypted ? 'https' : 'http'
    };

    ['for', 'port', 'proto'].forEach(function(header) {
      req.headers['x-forwarded-' + header] =
        (req.headers['x-forwarded-' + header] || '') +
        (req.headers['x-forwarded-' + header] ? ',' : '') +
        values[header];
    });

    req.headers['x-forwarded-host'] = (
      req.headers['x-forwarded-host'] || req.headers['host'] || ''
    );
  },

  /**
   * Does the actual proxying. If `forward` is enabled fires up
   * a ForwardStream, same happens for ProxyStream. The request
   * just dies otherwise.
   *
   * @param {ClientRequest} Req Request object
   * @param {IncomingMessage} Res Response object
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  stream: (request, response, options, _unused, server, callback) => {
    // And we begin!
    server.emit(
      'start', request, response, options.target || options.forward
    );

    var agents = (
      options.followRedirects
      ? followRedirectAgents 
      : nativeAgents
    );

    if (options.forward) {
      // If forward enable, so just pipe the request
      var forwardRequest = (
        getProtoAgent(agents, options.forward.protocol)
      ).request(
        common.setupOutgoing(options.ssl || {}, options, request, 'forward')
      );

      // error handler (e.g. ECONNRESET, ECONNREFUSED)
      // Handle errors on incoming request as well as it makes sense to
      var forwardError = createErrorHandler({
        server, request, response, 
        outgoindRequest: forwardRequest,
        parsedUrl: options.forward,
        callback
      });
      request.on('error', forwardError);
      forwardRequest.on('error', forwardError);

      (options.buffer || request).pipe(forwardRequest);
      
      if (!options.target) {
        return response.end();
      }
    }

    // Request initalization
    var proxyRequest = (
      getProtoAgent(agents, options.target.protocol)
    ).request(
      common.setupOutgoing(options.ssl || {}, options, request)
    );

    // Enable developers to modify the proxyReq before headers are sent
    proxyRequest.on('socket', function(socket) {
      if(server && !proxyRequest.getHeader('expect')) {
        server.emit('proxyReq', proxyRequest, request, response, options);
      }
    });

    // allow outgoing socket to timeout so that we could
    // show an error page at the initial request
    if(options.proxyTimeout) {
      proxyRequest.setTimeout(options.proxyTimeout, () => {
         proxyRequest.abort();
      });
    }

    // Ensure we abort proxy if request is aborted
    request.on('aborted', () => {
      proxyRequest.abort();
    });

    // handle errors in proxy and incoming request, just like for forward proxy
    var proxyError = createErrorHandler({
      server, request, response, 
      outgoindRequest: proxyRequest,
      parsedUrl: options.target,
      callback
    });
    request.on('error', proxyError);
    proxyRequest.on('error', proxyError);

    //function createErrorHandler(proxyRequest, url) {
    //  return function proxyError(err) {
    //    if (request.socket.destroyed && err.code === 'ECONNRESET') {
    //      server.emit('econnreset', err, request, response, url);
    //      return proxyRequest.abort();
    //    }

    //    if (callback) {
    //      callback(err, request, response, url);
    //    } else {
    //      server.emit('error', err, request, response, url);
    //    }
    //  }
    //}

    (options.buffer || request).pipe(proxyRequest);

    proxyRequest.on('response', function(proxyResponse) {
      if (server) {
        server.emit('proxyRes', proxyResponse, request, response);
      }

      if(!response.headersSent && !options.selfHandleResponse) {
        for (var i=0; i < web_o.length; i++) {
          if (web_o[i](request, response, proxyResponse, options)) {
            break;
          }
        }
      }

      if (!response.finished) {
        // Allow us to listen when the proxy has completed
        proxyResponse.on('end', function () {
          if (server) {
            server.emit('end', request, response, proxyResponse);
          }
        });
        // We pipe to the response unless its expected to be handled by the user
        if (!options.selfHandleResponse) {
          proxyResponse.pipe(response);
        }
      } else {
        if (server) {
          server.emit('end', request, response, proxyResponse)
        };
      }
    });
  }

};

module.exports = passesByName;
