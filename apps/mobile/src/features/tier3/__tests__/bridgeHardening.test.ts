// WS08 fix round, items 1 and 2 (lifted from the reviewer's reproductions): what a script on the
// retailer's page can learn about the bridge, and what the bridge does with a password the person
// made visible or a field that is a password in all but its type attribute.
import { findByRole } from "@mp/retailers";
import { afterEach, describe, expect, it } from "vitest";
import { createPageHarness, type PageHarness, TEST_PAGE_URL, TEST_TOKEN } from "./jsdomPage";

const SECRET = "hunter2-test-password";

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(options: { requestTimeoutMs?: number } = {}) {
  page = createPageHarness(options);
  await page.host.navigate(TEST_PAGE_URL);
  return page;
}

describe("item 1: page scripts cannot find the token or intercept the bridge", () => {
  it("no property name on window carries the token", async () => {
    const p = await open();
    const names = p.window().eval("Object.getOwnPropertyNames(window)") as string[];
    expect(names.some((n) => n.includes(TEST_TOKEN))).toBe(false);
  });

  it("a userRequired forged from anything the page can enumerate is ignored", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    // The reviewer's attack, widened: every global name, and every suffix after an underscore,
    // tried as the token.
    p.window().eval(`
      (function () {
        var names = Object.getOwnPropertyNames(window);
        var guesses = [];
        names.forEach(function (n) {
          guesses.push(n);
          var i = n.lastIndexOf("_");
          if (i >= 0) guesses.push(n.slice(i + 1));
        });
        guesses.forEach(function (token) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            __mp: "mp-tier3-bridge", v: 1, token: token,
            type: "userRequired", reason: "captcha", url: location.href
          }));
        });
      })();
    `);
    await tick(50);
    expect(seen).toEqual([]);
  });

  it("swapping window.ReactNativeWebView.postMessage after install neither reads nor blocks the bridge", async () => {
    const p = await open({ requestTimeoutMs: 1500 });
    p.window().eval(`
      window.__leaked = [];
      window.ReactNativeWebView.postMessage = function (data) { window.__leaked.push(data); };
    `);
    const tree = await p.host.snapshot();
    expect(tree.title).toBe("Fixture Pantry test page");
    expect(p.window().eval("window.__leaked.length")).toBe(0);
  });
});

describe("item 2: a password is never serialized or typed, whatever its type attribute says", () => {
  async function showSignin(p: PageHarness) {
    const button = findByRole(await p.host.snapshot(), "button", "Sign in")[0];
    if (!button) throw new Error("no sign in button");
    await p.host.click(button.id);
  }

  it("a password the person toggled visible (type=text) keeps its value out and refuses typing", async () => {
    const p = await open();
    await showSignin(p);
    const pw = p.window().document.getElementById("password") as HTMLInputElement;
    pw.value = SECRET;
    pw.setAttribute("type", "text"); // the eye icon most sign-in forms offer
    const tree = await p.host.snapshot();
    expect(JSON.stringify(tree)).not.toContain(SECRET);
    const [field] = findByRole(tree, "textbox", "Password");
    if (!field) throw new Error("the visible password field is not in the tree");
    expect(field.value).toBeUndefined();
    await expect(p.host.type(field.id, "x")).rejects.toMatchObject({ code: "password_field" });
    expect(pw.value).toBe(SECRET);
  });

  it("a type=text field with autocomplete=current-password or new-password is a password", async () => {
    const p = await open();
    const doc = p.window().document;
    for (const auto of ["current-password", "new-password", "username current-password"]) {
      const input = doc.createElement("input");
      input.setAttribute("type", "text");
      input.setAttribute("autocomplete", auto);
      input.setAttribute("aria-label", `Account secret ${auto}`);
      input.value = `${SECRET}-${auto}`;
      doc.body.appendChild(input);
    }
    const tree = await p.host.snapshot();
    expect(JSON.stringify(tree)).not.toContain(SECRET);
    const fields = findByRole(tree, "textbox", /^Account secret/);
    expect(fields).toHaveLength(3);
    for (const f of fields) {
      expect(f.value).toBeUndefined();
      await expect(p.host.type(f.id, "x")).rejects.toMatchObject({ code: "password_field" });
    }
  });

  it("a field whose name, id, label or placeholder says password, passcode or pwd is a password", async () => {
    const p = await open();
    const doc = p.window().document;
    const cases: [string, string][] = [
      ["name", "user_password"],
      ["id", "pwd-field"],
      ["placeholder", "Your passcode"],
      ["aria-label", "Pass code"],
    ];
    cases.forEach(([attr, value], i) => {
      const input = doc.createElement("input");
      input.setAttribute("type", "text");
      input.setAttribute(attr, value);
      if (attr !== "aria-label") input.setAttribute("aria-label", `Secret field ${i}`);
      input.value = `${SECRET}-${i}`;
      doc.body.appendChild(input);
    });
    const label = doc.createElement("label");
    label.textContent = "Password ";
    const labelled = doc.createElement("input");
    labelled.value = `${SECRET}-label`;
    label.appendChild(labelled);
    doc.body.appendChild(label);

    const tree = await p.host.snapshot();
    expect(JSON.stringify(tree)).not.toContain(SECRET);
  });

  it("ordinary fields keep their values", async () => {
    const p = await open();
    const box = findByRole(await p.host.snapshot(), "searchbox", "Search products")[0];
    if (!box) throw new Error("no search box");
    await p.host.type(box.id, "oat milk");
    const after = findByRole(await p.host.snapshot(), "searchbox", "Search products")[0];
    expect(after?.value).toBe("oat milk");
  });
});
