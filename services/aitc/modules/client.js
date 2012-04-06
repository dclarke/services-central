/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is AitC Client
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2012
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Ian Bicking <ianb@mozilla.com>
 *  Anant Narayanan <anant@kix.in>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-sync/rest.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://gre/modules/Webapps.jsm");

const EXPORTED_SYMBOLS = [
  'AitcClient'
];

function AuthRESTRequest(uri, authToken) {
  RESTRequest.call(this, uri);
  this.authToken = authToken;
  this._log.level = 20;
  this._log.appenders.push(new Log4Moz.DumpAppender());
}

AuthRESTRequest.prototype = {
  __proto__: RESTRequest.prototype,
  dispatch: function dispatch(method, data, onComplete, onProgress) {
    var sig = Utils.computeHTTPMACSHA1(
      this.authToken.id,
      this.authToken.key,
      method,
      this.uri,
      {}
    );
    this.setHeader("Authorization", sig.getHeader());
    dump("!! Complete request: " + method + " " + this.uri.asciiSpec + "\n");
    RESTRequest.prototype.dispatch.call(this, method, data, function (error) {
      dump("!! Request result: " + this.uri.asciiSpec + " status: " + this.status + " body: " + this.response.body + "\n");
      onComplete(error);
    }, onProgress);
  }
};

function AitcClient(token, registry) {
  this.uri = token.api_endpoint.replace(/\/+$/, '');
  dump('!!! AITC !!! token endpoint: ' + this.uri + '\n');
  this.token = token;
  this.registry = registry || DOMApplicationRegistry;
  // FIXME: should this be handled by the caller?
  this.appsLastModified = null;
  this.devicesLastModified = null;
  this.registry.confirmRemoteInstall = this.remoteInstall.bind(this);
  dump('!!! AITC !!! initialized client: ' + registry + '\n');
}

AitcClient.prototype = {
  _log: null,

  _makeRequest: function _makeRequest(uri) {
    if (typeof uri != 'string') {
      throw 'Bad request URI: ' + uri;
    }
    return new AuthRESTRequest(uri, this.token);
  },

  error: function (error) {
    if (this.onerror) {
      this.onerror(error);
    }
  },

  getApps: function getApps(cb) {
    var self = this;
    var req = this._makeRequest(this.uri + '/apps/?full=1');
    if (this.collectionLastModified) {
      req.setHeader("X-If-Modified-Since", this.appsLastModified);
    }
    req.get(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.response.status == 304) {
        cb(null, null);
      }

      dump("!!! AITC !!! Got from getApps: " + req.response.body + " :: " + req.response.body.length + "\n");
      var tmp = JSON.parse(req.response.body);
      cb(null, tmp["apps"]);
      self.appsLastModified = parseInt(req.response.headers['x-timestamp']);
    });
  },

  getAppDetails: function getDetails(since, cb) {
    var self = this;
    var uri = this.uri + '/apps/?full=1';
    if (since) {
      uri += '&after=' + encodeURIComponent(since);
    }
    var req = this._makeRequest(this.uri);
    req.get(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.response.status == 204) {
        cb(null, []);
        return;
      }
      cb(null, JSON.parse(req.response.body));
    });
  },

  _makeAppURI: function _makeAppURI(origin) {
    var part = btoa(origin).replace(/\+/, '-').replace(/\//, '_').replace(/=/, '');
    return this.uri + '/apps/' + part;
  },

  putApp: function putApp(appRec, appLastModified, cb) {
    var self = this;
    var uri = this._makeAppURI(appRec.origin);
    var req = this._makeRequest(uri);
    if (appLastModified) {
      req.setHeader('X-If-Unmodified-Since', appLastModified);
    }
    req.put(JSON.stringify(appRec), function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  deleteApp: function deleteApp(origin, appLastModified, cb) {
    var self = this;
    var uri = this._makeAppURI(origin);
    var req = this._makeRequest(uri);
    if (appLastModified) {
      req.setHeader('X-If-Unmodified-Since', appLastModified);
    }
    req.delete(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  _validUUID: function _validUUID(uuid) {
    return uuid.search(/^[a-zA-Z0-9_-]+$/) == 0;
  },

  _makeDeviceURI: function _makeDeviceURI(deviceUUID) {
    if (! this._validUUID(deviceUUID)) {
      throw 'Not a valid UUID: ' + deviceUUID;
    }
    return this.uri + '/devices/' + deviceUUID;
  },

  getDevices: function getDevices(cb) {
    var self = this;
    var req = this._makeRequest(this.uri + '/devices/');
    if (this.devicesLastModified) {
      req.setHeader('X-If-Modified-Since', this.devicesLastModified);
    }
    req.get(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 304) {
        cb(null, null);
        return;
      }
      cb(null, JSON.parse(this.response.body));
    });
  },

  putDevice: function (data, lastModified, cb) {
    var self = this;
    var req = this._makeRequest(this._makeDeviceURI(data.uuid));
    if (lastModified) {
      req.setHeader('X-If-Unmodified-Since', lastModified);
    }
    req.put(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  deleteDevice: function (uuid, lastModified, cb) {
    var self = this;
    var req = this._makeRequest(this._makeDeviceURI(uuid));
    if (lastModified) {
      req.setHeader('X-If-Unmodified-Since', lastModified);
    }
    req.delete(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  deleteCollection: function (cb) {
    var self = this;
    var req = this._makeRequest(this.uri);
    req.delete(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      cb();
    });
  },

  processResponse: function processResponse(resp, callback) {
    var self = this;
    var allApps = DOMApplicationRegistry.getAllWithoutManifests(function (apps) {
      var existingByOrigin = {};
      var originToId = {};
      var toDelete = {};
      var commands = [];
      for (var i in apps) {
        originToId[apps[i].origin] = i;
        existingByOrigin[apps[i].origin] = toDelete[apps[i].origin] = apps[i];
      }
      for (var i=0; i<resp.length; i++) {
        var origin = resp[i].origin;
        delete toDelete[origin];
        if ((! (origin in existingByOrigin)) || existingByOrigin[origin].installTime < resp[i].installTime) {
          var id = originToId[origin] || DOMApplicationRegistry.makeAppId();
          var record = {id: id, value: resp[i]};
          commands.push(record);
        }
      }
      for (var i in toDelete) {
        commands.push({id: originToId[i], deleted: true});
      }
      if (commands.length) {
        DOMApplicationRegistry.updateApps(commands, callback);
      } else {
        callback();
      }
    });
  },

  checkServer: function checkServer() {
    var self = this;
    dump('!!! AITC !!! Starting server check\n');
    this.getApps(function (error, apps) {
      dump('!!! AITC !!! got apps ' + apps.length + "\n");
      if (apps && ! error) {
        self.processResponse(apps, function () {
          dump('!!! saved result\n');
        });
      }
    });
  },

  runPeriodically: function runPeriodically() {
    var self = this;
    this.timer = Cc["@mozilla.org/timer;1"]
      .createInstance(Ci.nsITimer);
    var event = {
      notify: function (timer) {
        self.checkServer();
      }
    };
    this.timer.initWithCallback(event, 10000, Ci.nsITimer.TYPE_REPEATING_SLACK);
  },

  remoteInstall: function (app, callback) {
    dump("!!! AITC !!! putting app: " + app.origin + "\n");
    this.putApp(app, null, function (error) {
      if (! error) {
        callback();
      }
    });
  }

};
