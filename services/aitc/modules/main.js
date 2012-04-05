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

const ID_URI = "http://127.0.0.1:10002";

Cu.import("resource://gre/modules/Services.jsm");

function AitcSvc() {
  dump("!!! AITC !!! Service initialized\n");
}
AitcSvc.prototype = {
	getAssertion: function _getAssertion(email, audience, cb) {
		let appShell = Cc["@mozilla.org/appshell/appShellService;1"]
			.getService(Ci.nsIAppShellService);
    let hiddenDOMWindow = appShell.hiddenDOMWindow;

    let frame = hiddenDOMWindow.document.createElement("iframe");
    frame.setAttribute("type", "content");
    frame.setAttribute("src", ID_URI);

    let injectController = function(doc, topic, data) {
      if (!doc.defaultView || doc.defaultView != frame.contentWindow) {
        throw "No window found";
      }
      Services.obs.removeObserver(injectController, 'document-element-inserted', false);
      
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

      workerWindow.addEventListener("load", function() {
        let scriptText = 
          "window.BrowserID.User.getAssertion('" + email + "', '" + audience +
          "', successCb, errorCb);";
        Cu.evalInSandbox(scriptText, sandbox, "1.8", workerWindow.location.href, 1);  
      }, true);
    };

    Services.obs.addObserver(injectController, 'document-element-inserted', false);
    let doc = hiddenDOMWindow.document;
    let container = doc.body ? doc.body : doc.documentElement;
    container.appendChild(frame);
	}
};

let Aitc = new AitcSvc();
Aitc.getAssertion('anant@kix.in', 'http://google.com', function(err, res) {
	if (err) dump("!!! AITC !!! ERROR: " + err + "\n");
	else dump("!!! AITC !!! Got assertion: " + res + "\n");
});
