import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createUploadManager } from "../web/uploads.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function fixture(api) {
  const dom = new JSDOM('<div id="modal"></div>', {
    url: "https://laras.test",
  });
  const doc = dom.window.document;
  const root = doc.querySelector("#modal");
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const manager = createUploadManager({
    api,
    state: { backend: { cloud: { projectName: "Laras Bisnis" } } },
    document: doc,
    crypto,
    escape,
    icon: () => "",
    openModal: (html) => (root.innerHTML = html),
    closeModal: () => (root.innerHTML = ""),
    initializeBackend: async () => {},
    toast() {},
  });
  manager.handleClick({ dataset: { action: "cloud-connect" } });
  const get = (selector) => doc.querySelector(selector);
  return {
    dom,
    get,
    inputToken(value) {
      get("#cloud-token").value = value;
      get("#cloud-token").dispatchEvent(new dom.window.Event("input"));
    },
    submit() {
      get("#cloud-connection-form").dispatchEvent(
        new dom.window.Event("submit", { cancelable: true }),
      );
    },
  };
}

test("connection UI chooses real organization IDs by display name and accepts the user's project name", async () => {
  const requests = [];
  const f = fixture(async (path, options) => {
    requests.push({ path, body: options.body });
    return path.endsWith("organizations")
      ? {
          organizations: [
            { slug: "canonical-org", name: "Bagasta <img src=x>" },
            { slug: "other-org", name: "Organisasi lain" },
          ],
        }
      : { saved: true };
  });
  try {
    assert.equal(f.get("#cloud-organization").tagName, "SELECT");
    assert.equal(f.get("#cloud-connect-submit").disabled, true);
    f.inputToken("fixture-token");
    f.get("#cloud-check-token").click();
    await tick();
    assert.equal(f.get("#cloud-organization").disabled, false);
    assert.equal(f.get("#cloud-connect-submit").disabled, true);
    assert.equal(f.get("img"), null);
    f.get("#cloud-organization").value = "canonical-org";
    f.get("#cloud-organization").dispatchEvent(
      new f.dom.window.Event("change"),
    );
    f.get("#cloud-project-name").value = "bagasta's Project";
    assert.equal(f.get("#cloud-connect-submit").disabled, false);
    f.submit();
    await tick();
    assert.equal(requests[1].body.organization, "canonical-org");
    assert.equal(requests[1].body.projectName, "bagasta's Project");
    assert.equal(f.get("#cloud-token"), null);
    assert.equal(f.dom.window.localStorage.length, 0);
  } finally {
    f.dom.window.close();
  }
});

test("a changed token invalidates organization choices and stale lookup responses cannot enable saving", async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    f.inputToken("old-token");
    f.get("#cloud-check-token").click();
    f.inputToken("new-token");
    finish({ organizations: [{ slug: "old-org", name: "Old account" }] });
    await tick();
    assert.equal(f.get("#cloud-organization").disabled, true);
    assert.equal(f.get("#cloud-connect-submit").disabled, true);
    assert.equal(f.get('option[value="old-org"]'), null);
    f.get("#cloud-check-token").click();
    finish({ organizations: [{ slug: "new-org", name: "New account" }] });
    await tick();
    assert.equal(f.get("#cloud-organization").value, "new-org");
    assert.equal(f.get("#cloud-connect-submit").disabled, false);
  } finally {
    f.dom.window.close();
  }
});

test("failed or empty token lookups keep saving disabled and show the error", async () => {
  let invalid = true;
  const f = fixture(async () => {
    if (invalid) {
      const error = new Error("Token tidak valid.");
      error.code = "SUPABASE_TOKEN_INVALID";
      throw error;
    }
    return { organizations: [] };
  });
  try {
    f.inputToken("bad-token");
    f.get("#cloud-check-token").click();
    await tick();
    assert.match(f.get("#cloud-form-error").textContent, /Token tidak valid/);
    assert.equal(f.get("#cloud-token").value, "");
    assert.equal(f.get("#cloud-connect-submit").disabled, true);
    invalid = false;
    f.inputToken("good-token");
    f.get("#cloud-check-token").click();
    await tick();
    assert.match(
      f.get("#cloud-form-error").textContent,
      /Tidak ada organisasi/,
    );
    assert.equal(f.get("#cloud-connect-submit").disabled, true);
  } finally {
    f.dom.window.close();
  }
});
