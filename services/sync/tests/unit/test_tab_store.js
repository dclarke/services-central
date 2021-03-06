Cu.import("resource://services-sync/engines/tabs.js");
Cu.import("resource://services-sync/util.js");

function run_test() {
  run_next_test();
}

add_test(function test_lastUsed() {
  let store = new TabEngine()._store;

  _("Check extraction of last used times from tab objects.");
  let expected = [
    [0,         {}],
    [0,         {extData: null}],
    [0,         {extData: {}}],
    [0,         {extData: {weaveLastUsed: null}}],
    [123456789, {extData: {weaveLastUsed: "123456789"}}],
    [123456789, {extData: {weaveLastUsed: 123456789}}],
    [123456789, {extData: {weaveLastUsed: 123456789.12}}]
  ];

  for each (let [ex, input] in expected) {
    do_check_eq(ex, store.tabLastUsed(input));
  }

  run_next_test();
});

add_test(function test_create() {
  let store = new TabEngine()._store;

  _("Create a first record");

  let now = Date.now();
  let rec = {id: "id1",
             clientName: "clientName1",
             cleartext: "cleartext1",
             modified: now};
  store.applyIncoming(rec);
  do_check_eq(store._remoteClients["id1"], "cleartext1");
  do_check_eq(Svc.Prefs.get("notifyTabState"), now);

  _("Create a second record");
  let rec = {id: "id2",
             clientName: "clientName2",
             cleartext: "cleartext2",
             modified: now + 1000};
  store.applyIncoming(rec);
  do_check_eq(store._remoteClients["id2"], "cleartext2");
  do_check_eq(Svc.Prefs.get("notifyTabState"), 0);

  _("Create a third record");
  let rec = {id: "id3",
             clientName: "clientName3",
             cleartext: "cleartext3",
             modified: now + 2000};
  store.applyIncoming(rec);
  do_check_eq(store._remoteClients["id3"], "cleartext3");
  do_check_eq(Svc.Prefs.get("notifyTabState"), 0);

  // reset the notifyTabState
  Svc.Prefs.reset("notifyTabState");

  run_next_test();
});

function fakeSessionSvc(url, numtabs) {
  // first delete the getter, or the previously
  // created fake Session
  delete Svc.Session;
  Svc.Session = {
    getBrowserState: function() {
      let obj = {
        windows: [{
          tabs: [{
            index: 1,
            entries: [{
              url: url,
              title: "title"
            }],
            attributes: {
              image: "image"
            },
            extData: {
              weaveLastUsed: 1
            }
          }]
        }]
      };
      if (numtabs) {
        let tabs = obj.windows[0].tabs;
        for (let i = 0; i < numtabs-1; i++)
          tabs.push(deepCopy(tabs[0]));
      }
      return JSON.stringify(obj);
    }
  };
};

add_test(function test_getAllTabs() {
  let store = new TabEngine()._store, tabs;

  _("get all tabs");
  fakeSessionSvc("http://foo.com");
  tabs = store.getAllTabs();
  do_check_eq(tabs.length, 1);
  do_check_eq(tabs[0].title, "title");
  do_check_eq(tabs[0].urlHistory.length, 1);
  do_check_eq(tabs[0].urlHistory[0], ["http://foo.com"]);
  do_check_eq(tabs[0].icon, "image");
  do_check_eq(tabs[0].lastUsed, 1);

  _("get all tabs, and check that filtering works");
  // we don't bother testing every URL type here, the
  // filteredUrls regex really should have it own tests
  fakeSessionSvc("about:foo");
  tabs = store.getAllTabs(true);
  do_check_eq(tabs.length, 0);

  run_next_test();
});

add_test(function test_createRecord() {
  let store = new TabEngine()._store, record;

  // get some values before testing
  fakeSessionSvc("http://foo.com");
  let tabs = store.getAllTabs();
  let tabsize = JSON.stringify(tabs[0]).length;
  let numtabs = Math.ceil(20000./77.);

  _("create a record");
  fakeSessionSvc("http://foo.com");
  record = store.createRecord("fake-guid");
  do_check_true(record instanceof TabSetRecord);
  do_check_eq(record.tabs.length, 1);

  _("create a big record");
  fakeSessionSvc("http://foo.com", numtabs);
  record = store.createRecord("fake-guid");
  do_check_true(record instanceof TabSetRecord);
  do_check_eq(record.tabs.length, 256);

  run_next_test();
});
