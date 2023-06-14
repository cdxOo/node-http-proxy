'use strict'
// vim: shiftwidth=2
var { _extend, inherits } = require('util');
var parse_url = require('url').parse;
var EE3 = require('eventemitter3');
var http = require('http');
var https = require('https');
var web = require('./passes/web-incoming');
var ws = require('./passes/ws-incoming');

var httpProxy = module.exports;

/**
 * Returns a function that creates the loader for
 * either `ws` or `web`'s  passes.
 *
 * Examples:
 *
 *    httpProxy.createRightProxy('ws')
 *    // => [Function]
 *
 * @param {String} Type Either 'ws' or 'web'
 * 
 * @return {Function} Loader Function that when called returns an iterator for the right passes
 *
 * @api private
 */

httpProxy.createRightProxy = function createRightProxy(type) {
  return function(options) {
    return function(...args) {
      var [ request, response, ...optionalArgs /*[head], [moreOptions], [callback??]*/] = args;

      var passes = (type === 'ws') ? this.wsPasses : this.webPasses;

      var { head, moreOptions, callback } = parseOptionalArgs(optionalArgs);
      var requestOptions = { ...options, ...moreOptions };

      ['target', 'forward'].forEach(function(e) {
        if (typeof requestOptions[e] === 'string') {
          requestOptions[e] = parse_url(requestOptions[e])
        };
      });

      if (!requestOptions.target && !requestOptions.forward) {
        return this.emit('error', new Error('Must provide a proper URL as target'));
      }

      for (var i=0; i < passes.length; i++) {
        /**
         * Call of passes functions
         * pass(request, response, options, head)
         *
         * In WebSockets case the `response` variable
         * refer to the connection socket
         * pass(req, socket, options, head)
         */
        if (passes[i](request, response, requestOptions, head, this, callback)) {
          // passes can return a truthy value to halt the loop
          break;
        }
      }
    };
  };
}

var parseOptionalArgs = (args) => {
  var argIndex = args.length - 1;
  var head, moreOptions, callback;

  /* optional args parse begin */
  if (typeof args[argIndex] === 'function') {
    callback = args[argIndex];
    argIndex--;
  }

  if (!(args[argIndex] instanceof Buffer)) {
    moreOptions = args[argIndex];
    argIndex--;
  }

  if (args[argIndex] instanceof Buffer) {
    head = args[argIndex];
  }

  return { head, moreOptions, callback }
}

httpProxy.Server = class ProxyServer extends EE3 {
  constructor (options) {
    super();

    options = options || {};
    options.prependPath = options.prependPath === false ? false : true;

    this.web = this.proxyRequest = httpProxy.createRightProxy('web')(options);
    this.ws  = this.proxyWebsocketRequest = httpProxy.createRightProxy('ws')(options);
    this.options = options;

    this.webPasses = Object.keys(web).map(function(pass) {
      return web[pass];
    });

    this.wsPasses = Object.keys(ws).map(function(pass) {
      return ws[pass];
    });

    this.on('error', this.onError, this);

  }

  onError (err) {
    //
    // Remark: Replicate node core behavior using EE3
    // so we force people to handle their own errors
    //
    if(this.listeners('error').length === 1) {
      throw err;
    }
  }

  listen (port, hostname) {
    var self    = this,
        closure = function(request, response) { self.web(request, response); };

    this._server  = this.options.ssl ?
      https.createServer(this.options.ssl, closure) :
      http.createServer(closure);

    if(this.options.ws) {
      this._server.on('upgrade', function(request, socket, head) { self.ws(request, socket, head); });
    }

    this._server.listen(port, hostname);

    return this;
  }

  close (callback) {
    var self = this;
    if (this._server) {
      this._server.close(done);
    }

    // Wrap callback to nullify server after all open connections are closed.
    function done() {
      self._server = null;
      if (callback) {
        callback.apply(null, arguments);
      }
    };
  }

  __findInjectPoint (type, passName) {
    if (type !== 'ws' && type !== 'web') {
      throw new Error('type must be `web` or `ws`');
    }
    var passes = (type === 'ws') ? this.wsPasses : this.webPasses;

    var i = false;
    passes.forEach(function(v, idx) {
      if(v.name === passName) i = idx;
    })

    if(i === false) throw new Error('No such pass');
    return [ passes, i ];
  };

  // NOTE: there are no tests for that
  // so i dont know what the expected behavior actually is
  before (type, passName, callback) {
    var [ passes, i ] = this.__findInjectPoint(type, passName);
    passes.splice(i, 0, callback);
  };

  // NOTE: there are no tests for that
  // so i dont know what the expected behavior actually is
  after (type, passName, callback) {
    var [ passes, i ] = this.__findInjectPoint(type, passName);
    passes.splice(i++, 0, callback);
  };

}

