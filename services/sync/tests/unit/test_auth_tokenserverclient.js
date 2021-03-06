/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/auth.js");

function run_test() {
  initTestLogging("Trace");

  run_next_test();
}

add_test(function test_working_bid_exchange() {
  _("Ensure that working BrowserID token exchange works as expected.");

  let service = "http://example.com/foo";

  let server = httpd_setup({
    "/1.0/foo/1.0": function(request, response) {
      do_check_true(request.hasHeader("accept"));
      do_check_eq("application/json", request.getHeader("accept"));

      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");

      let body = JSON.stringify({id: "id", key: "key", service_entry: service});
      response.bodyOutputStream.write(body, body.length);
    }
  });

  let client = new TokenServerClient();
  let cb = Async.makeSpinningCallback();
  let url = TEST_SERVER_URL + "1.0/foo/1.0";
  client.getTokenFromBrowserIDAssertion(url, "assertion", cb);
  let result = cb.wait();
  do_check_eq("object", typeof(result));
  do_check_attribute_count(result, 3);
  do_check_eq(service, result.serviceEntry);
  do_check_eq("id", result.id);
  do_check_eq("key", result.key);

  server.stop(run_next_test);
});

add_test(function test_invalid_arguments() {
  _("Ensure invalid arguments to APIs are rejected.");

  let args = [
    [null, "assertion", function() {}],
    ["http://example.com/", null, function() {}],
    ["http://example.com/", "assertion", null]
  ];

  for each (let arg in args) {
    try {
      let client = new TokenServerClient();
      client.getTokenFromBrowserIDAssertion(arg[0], arg[1], arg[2]);
      do_check_true(false);
    } catch (ex) {
      do_check_true(ex instanceof TokenServerClientError);
    }
  }

  run_next_test();
});

add_test(function test_error_404() {
  _("Ensure that 404 responses result in error.");

  let server = httpd_setup();

  let client = new TokenServerClient();
  let url = TEST_SERVER_URL + "foo";
  client.getTokenFromBrowserIDAssertion(url, "assertion", function(error, r) {
    do_check_neq(null, error);
    do_check_eq("TokenServerClientServerError", error.name);
    do_check_neq(null, error.response);
    do_check_eq(null, r);

    server.stop(run_next_test);
  });
});

add_test(function test_bad_json() {
  _("Ensure that malformed JSON is handled properly.");

  let server = httpd_setup({
    "/1.0/foo/1.0": function(request, response) {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");

      let body = '{"id": "id", baz}'
      response.bodyOutputStream.write(body, body.length);
    }
  });

  let client = new TokenServerClient();
  let url = TEST_SERVER_URL + "1.0/foo/1.0";
  client.getTokenFromBrowserIDAssertion(url, "assertion", function(error, r) {
    _(error);
    do_check_neq(null, error);
    do_check_eq("TokenServerClientServerError", error.name);
    do_check_neq(null, error.response);
    do_check_eq(null, r);

    server.stop(run_next_test);
  });
});

add_test(function test_unhandled_media_type() {
  _("Ensure that unhandled media types throw an error.");

  let server = httpd_setup({
    "/1.0/foo/1.0": function(request, response) {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "text/plain");

      let body = "hello, world";
      response.bodyOutputStream.write(body, body.length);
    }
  });

  let url = TEST_SERVER_URL + "1.0/foo/1.0";
  let client = new TokenServerClient();
  client.getTokenFromBrowserIDAssertion(url, "assertion", function(error, r) {
    do_check_neq(null, error);
    do_check_eq("TokenServerClientError", error.name);
    do_check_neq(null, error.response);
    do_check_eq(null, r);

    server.stop(run_next_test);
  });
});

add_test(function test_rich_media_types() {
  _("Ensure that extra tokens in the media type aren't rejected.");

  let server = httpd_setup({
    "/foo": function(request, response) {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json; foo=bar; bar=foo");

      let body = JSON.stringify({id: "id", key: "key", service_entry: "foo"});
      response.bodyOutputStream.write(body, body.length);
    }
  });

  let url = TEST_SERVER_URL + "foo";
  let client = new TokenServerClient();
  client.getTokenFromBrowserIDAssertion(url, "assertion", function(error, r) {
    do_check_eq(null, error);

    server.stop(run_next_test);
  });
});
