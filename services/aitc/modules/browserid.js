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

const EXPORTED_SYMBOLS = ["BrowserID"];
const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

// TODO: Make pref so it's easy to switch to dev
const ID_URI = "https://browserid.org";

function BrowserIDSvc() {
	this._frame = null;
	this._container = null;
	this._emails = [];
}
BrowserIDSvc.prototype = {
	_getSandbox: function(cb) {
    if (this._frame) {
      // TODO: Figure out how we can reuse the same iframe
      // Recreate each time, for now.
      this._container.removeChild(this._frame);
      this._frame = null;
    }

  	/*
  	let appShell = Cc["@mozilla.org/appshell/appShellService;1"]
    	.getService(Ci.nsIAppShellService);
  	let hiddenDOMWindow = appShell.hiddenDOMWindow;
  	let doc = hiddenDOMWindow.document;
  	*/
  	// This way of obtaining a window is more fickle than the commented way
  	// but appShellService doesn't work sometimes. Investigate.
  	let wM = Cc["@mozilla.org/appshell/window-mediator;1"]
    	.getService(Ci.nsIWindowMediator);
  	let win = wM.getMostRecentWindow("navigator:browser");
  	let doc = win.document;

  	// Insert iframe in to create docshell
  	let frame = doc.createElement("iframe");
  	frame.setAttribute("type", "content");
  	frame.setAttribute("collapsed", "true");
  	doc.documentElement.appendChild(frame);

  	// Set instance properties for reuse
  	this._frame = frame;
  	this._container = doc.documentElement;

  	// Stop about:blank from being loaded
  	let webNav = frame.docShell.QueryInterface(Ci.nsIWebNavigation);
  	webNav.stop(Ci.nsIWebNavigation.STOP_NETWORK);

    let self = this;
		let parseHandler = {
      handleEvent: function(event) {
        event.target.removeEventListener("DOMContentLoaded", this, false);
        let workerWindow = self._frame.contentWindow;
        let sandbox = new Cu.Sandbox(workerWindow, {
          sandboxPrototype: workerWindow,
          wantXrays: false
        });
        cb(sandbox);
      }
    };

    // Make channel
    let iOservice = Cc["@mozilla.org/network/io-service;1"]
      .getService(Ci.nsIIOService);
    let channel = iOservice.newChannel(ID_URI, null, null);

    // Load the iframe
    this._frame.addEventListener("DOMContentLoaded", parseHandler, true);
    let uriLoader = Cc["@mozilla.org/uriloader;1"].getService(Ci.nsIURILoader);
    uriLoader.openURI(channel, true, this._frame.docShell);
	},

	// Obtain a BrowserID assertion (if user is already logged in)
  getAssertion: function(email, audience, cb) {
    let address = email;
    if (!address) {
      if (!this._emails.length === 0) {
        dump("!!! AITC error: getAssertion called when user is not loggedIn\n");
        cb("ERROR: Not logged in", null);
        return;
      } else {
        // Just pick the first one in the list
        address = this._emails[0];
      }
    }
    if (!audience) {
      cb("ERROR: audience not provided", null);
      return;
    }

  	this._getSandbox(function(sandbox) {
  		function successCb(res) {
				cb(null, res);
			}
			function errorCb(err) {
				cb(err, null);
			}
			sandbox.importFunction(successCb, "successCb");
			sandbox.importFunction(errorCb, "errorCb");

			let scriptText = 
				"window.BrowserID.User.getAssertion('" + address + "', '" + audience +
				"', successCb, errorCb);";
			Cu.evalInSandbox(scriptText, sandbox, "1.8", ID_URI, 1);
  	});
  },

  // Check if a user is logged in to browserid.org
  isLoggedIn: function _isLoggedIn(cb) {
  	let self = this;
  	this._getSandbox(function(sandbox) {
  		function callback(res) {
  			try {
  				let list = JSON.parse(res);
          let keys = Object.keys(list);
          if (keys.length === 0) {
            cb(false);
          } else {
            self._emails = keys;
            cb(true);
          }
  			} catch (e) {
          dump("!!! AITC Exception in isLoggedIn " + e + "\n");
  				cb(false); return;
  			}
  		}
  		sandbox.importFunction(callback, "callback");
  		let scriptText = 
  			"var list = window.BrowserID.User.getStoredEmailKeypairs();" + 
  			"callback(JSON.stringify(list));";
  		Cu.evalInSandbox(scriptText, sandbox, "1.8", ID_URI, 1);
  	});
  },

  // List all emails associated with this user on browserid.org
 	listEmails: function(cb) {
 		let self = this;
 		if (this._emails.length === 0) {
 			this._isLoggedIn(function(yes) {
 				if (yes) cb(self._emails);
 				else cb([]);
 			});
 		} else {
 			cb(this._emails);
 		}
 	},

 	// Get the email last used to login to audience
 	getEmailForAudience: function(audience, cb) {
 		let self = this;
 		this._getSandbox(function(sandbox) {
 			sandbox.importFunction(cb, "callback");
 			let scriptText = 
 				"callback(window.BrowserID.Storage.site.get('" +
 					audience + "', 'email'));";
 			Cu.evalInSandbox(scriptText, sandbox, "1.8", ID_URI, 1);
 		});
 	}
};

let BrowserID = new BrowserIDSvc();

