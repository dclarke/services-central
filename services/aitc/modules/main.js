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
 * The Original Code is Apps in the Cloud.
 *
 * The Initial Developer of the Original Code is the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2012.
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
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

const EXPORTED_SYMBOLS = ["Aitc"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

// TODO: get these from preferences instead of hardcoding.
const ID_URI = "https://browserid.org/sign_in";
const TOKEN_URI = "http://token2.reg.mtv1.dev.svc.mozilla.com";

Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/auth.js");
Cu.import("resource://gre/modules/Webapps.jsm");

// TODO: get rid of dump()s.
function AitcSvc() {
  this._token = null;
  this._client = null;
  dump("!!! AITC !!! Service initialized\n");
}
AitcSvc.prototype = {

  // Obtain a BrowserID assertion (if user is already logged in)
  getAssertion: function _getAssertion(email, audience, cb) {

    /*
    let appShell = Cc["@mozilla.org/appshell/appShellService;1"]
      .getService(Ci.nsIAppShellService);
    let hiddenDOMWindow = appShell.hiddenDOMWindow;
    let doc = hiddenDOMWindow.document;
    */

    // This way of obtaining a window is more fickle than the commented way
    let wM = Cc["@mozilla.org/appshell/window-mediator;1"]
      .getService(Ci.nsIWindowMediator);
    let win = wM.getMostRecentWindow("navigator:browser");
    let doc = win.document;

    // Insert iframe in to create docshell
    let frame = doc.createElement("iframe");
    frame.setAttribute("type", "content");
    frame.setAttribute("collapsed", "true");
    doc.documentElement.appendChild(frame);

    // Stop about:blank from being loaded
    let webNav = frame.docShell.QueryInterface(Ci.nsIWebNavigation);
    webNav.stop(Ci.nsIWebNavigation.STOP_NETWORK);

    let parseHandler = {
      handleEvent: function (event) {
        event.target.removeEventListener("DOMContentLoaded", this, false);

        let workerWindow = frame.contentWindow;
        let sandbox = new Cu.Sandbox(workerWindow, {
          sandboxPrototype: workerWindow,
          wantXrays: false
        });

        function successCb(res) {
          cb(null, res);
        }
        function errorCb(err) {
          cb(err, null);
        }
        sandbox.importFunction(successCb, "successCb");
        sandbox.importFunction(errorCb, "errorCb");
   
        let scriptText = 
          "window.BrowserID.User.getAssertion('" + email + "', '" + audience +
          "', successCb, errorCb);";
        Cu.evalInSandbox(scriptText, sandbox, "1.8", workerWindow.location.href, 1);
      }
    };

    // Make channel for URI
    let iOservice = Cc["@mozilla.org/network/io-service;1"]
      .getService(Ci.nsIIOService);
    let channel = iOservice.newChannel(ID_URI, null, null);

    // Load the iframe
    frame.addEventListener("DOMContentLoaded", parseHandler, true);
    let uriLoader = Cc["@mozilla.org/uriloader;1"].getService(Ci.nsIURILoader);
    uriLoader.openURI(channel, true, frame.docShell);
  },

  // Obtain a token from Sagrada token server
  getToken: function _getToken(assertion, cb) {
    let url = TOKEN_URI + "/1.0/aitc/1.0";
    let client = new TokenServerClient();

    // Return long lived token for now (for development only)
    const ASSERTION = "eyJhbGciOiAiUlMyNTYifQ.eyJpc3MiOiAiYnJvd3NlcmlkLm9yZyIsICJwdWJsaWMta2V5IjogIlx1MDAwMFx1MDAwMFx1MDAwMFx1MDA4MVx1MDAwMFx1MDBjZGUhXHUwMDE1XHUwMGRhaFx1MDBiNWBcdTAwY2VbXHUwMGQ2XHUwMDE3ZFx1MDBiYThcdTAwYzFJXHUwMGIxXHUwMGYxXHUwMGJlclx1MDA4NktcdTAwYzdcdTAwZGFcdTAwYjNcdTAwOThcdTAwZDZcdTAwZjZcdTAwODBcdTAwYWVcdTAwYWFcdTAwOGYhXHUwMDlhXHUwMGVmUVx1MDBkZWhcdTAwYmJcdTAwYzVcdTAwOTlcdTAwMDFvXHUwMGViR09cdTAwOGVcdTAwOWJcdTAwOWFcdTAwMThcdTAwZmI2XHUwMGJhXHUwMDEyXHUwMGZjXHUwMGYyXHUwMDE3XHIkXHUwMDAwXHUwMGExXHUwMDFhIFx1MDBmYy9cdTAwMTNpVW1cdTAwMDRcdTAwMTNcdTAwMGZcdTAwOTFEflx1MDBiZlxiXHUwMDE5Q1x1MDAxYVx1MDBlMlx1MDBhM1x1MDA5MSZcdTAwOGZcdTAwY2ZcdTAwY2NcdTAwZjNcdTAwYTRIUmZcdTAwYWZcdTAwZjJcdTAwMTlcdTAwYmRcdTAwMDVcdTAwZTM2XHUwMDlhXHUwMGJiUVx1MDBjODZ8KFx1MDBhZFx1MDA4M1x1MDBmMkV1XHUwMGIyRUxcdTAwZGZcdTAwYTRAXHUwMDdmXHUwMGVlbHxcdTAwZmNVXHUwMDAzXHUwMGRiXHUwMDg5JyIsICJleHAiOiAxMzYzOTEwNzUwMzYwLCAicHJpbmNpcGFsIjogeyJlbWFpbCI6ICJ0ZXN0QGV4YW1wbGUuY29tIn19.RUQBy2rCtU1HTVqv6ngDIYe0lclVuFGKyQjKe3MA0UXefAP35KYs8nLuLM80m8I5vGBS42mqiq4TZDuNPy-vHZNJYw_qlnTSrsmccIPc3asFWXEw3PPvgLjtL49c60veKdDfkdQMUlMVWLDVNVi3O8spS-RyS1_Wa-XdvaPqIu0~eyJhbGciOiAiUlMyNTYifQ.eyJhdWQiOiAiKiIsICJleHAiOiAxMzYzOTEwNzUwMzYwfQ.ExWSBELUtM6yEyJdfTPu9220R59IhXKkQFtxSty3ZymR5wyVnjryHKLQWLmfEWzUrfl-6EZAjSMhZ_H78fviooFl_swcViN9SLU-m4ti9YOcZFR-htkk233yAtcZ5p1sSFo_Z5kWIzYp_nolPeBq3fgSQG_YEam7erUxGAeY080";
    let TOKEN = {
      "api_endpoint": "https://dev-aitc1.services.mozilla.com/1.0/42",
      "id": "eyJleHBpcmVzIjogMTM2NTAxMDg5OC4xMTk1MDk5LCAic2FsdCI6ICI1YTE3ZDYiLCAidWlkIjogNDJ9L7vI7dWORWRocv_flcwuxr59yxs=",
      "key": "qTZf4ZFpAMpMoeSsX3zVRjiqmNs=",
      "uid": 42
    };
    cb(TOKEN);
    return;

    // Token server doesn't support real assertions yet?
    client.getTokenFromBrowserIDAssertion(url, assertion, function(err, res) {
      if (!err.response) {
        dump("!!! AITC !!! Error while fetching token " + err + "\n");
        return;
      }
      if (!err.response.success) {
        dump("!!! AITC !!! Non-200 while fetching token " + err.response.status + "\n");
        return;
      }

      dump("!!! AITC !!! Got token " + res);
    });
  },

  ready: function(token) {
    this._token = token;
    Svc.Obs.add("webapps-sync-install", this);
    Svc.Obs.add("webapps-sync-uninstall", this);

    // Until we have a working dashboard, run client every 30 seconds
    Cu.import("resource://services-aitc/client.js");
    this._client = new AitcClient(this._token);
    this._client.runPeriodically();
  },

  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
    // TODO: Inform AitcClient about these events, or implement in client.js
    case "webapps-sync-install":
      dump("!!! AITC !!! app " + aData + " was installed\n");
      break;
    case "webapps-sync-uninstall":
      dump("!!! AITC !!! app " + aData + " was uninstalled\n");
      break;
    }
  }
};

let Aitc = new AitcSvc();
Aitc.getAssertion('anant@kix.in', 'http://google.com', function(err, res) {
  if (err) {
    dump("!!! AITC !!! ERROR: " + err + "\n");
  } else {
    dump("!!! AITC !!! Got assertion: " + res + "\n");
    Aitc.getToken(res, function(token) {
      Aitc.ready(token);
    });
  }
});
