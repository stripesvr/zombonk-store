// Upload API for the mod store. upload.html talks to this Worker:
//   /submit       anyone: queue a mod on the "submissions" branch for review
//   /login        admin: check the password, list store mods and submissions
//   /upload       admin: release a mod straight to the store
//   /review       admin: approve (release) or reject a queued submission
//   /delete       admin: remove a mod and its zip from the store
//   /download     admin: fetch a queued submission's zip
// Releases commit the zip and manifest entry to the store branch. The password
// and GitHub token are Worker secrets, so neither reaches the browser or repo.
// Submissions live on a separate branch, which GitHub Pages does not serve.

const LIMIT = 100 * 1024 * 1024; // GitHub rejects larger single files
const GUEST_LIMIT = 50 * 1024 * 1024;
const MAX_PENDING = 50;
const QUEUE = "submissions";

export default {
  async fetch(request, env) {
    // Any page may call this; the password is what protects the admin routes.
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    const routes = ["/submit", "/login", "/upload", "/review", "/download", "/delete"];
    if (request.method !== "POST" || !routes.includes(path)) return reply(404, { error: "Not found" });

    let form;
    try { form = await request.formData(); } catch { return reply(400, { error: "Bad request." }); }

    try {
      if (path === "/submit") return reply(200, await submit(form, env));

      if (!(await passwordOk(form.get("password"), env.UPLOAD_PASSWORD))) {
        await new Promise(r => setTimeout(r, 1500)); // slow down guessing
        return reply(401, { error: "Wrong password." });
      }
      if (path === "/login") {
        const [{ manifest }, queue] = await Promise.all([readStore(env), readQueue(env)]);
        return reply(200, { ok: true, mods: manifest.mods, submissions: queue.items });
      }
      if (path === "/upload") return reply(200, await release(await zipFrom(form, LIMIT), fieldsFrom(form), env));
      if (path === "/review") return reply(200, await review(form, env));
      if (path === "/delete") return reply(200, await remove(text(form, "id", 80), env));
      if (path === "/download") {
        const item = (await readQueue(env)).items.find(s => s.id === form.get("id"));
        if (!item) throw fail(404, "That submission is gone.");
        const bytes = await readBlob(env, item.zipSha);
        return new Response(bytes, { headers: { ...cors, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${slug(item.name) || "mod"}.zip"` } });
      }
    } catch (e) {
      return reply(e.status || 500, { error: e.message });
    }
  },
};

// Compare digests so the check takes the same time whatever was typed.
async function passwordOk(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

async function gh(env, path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.STORE_GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "zombonk-upload",
    },
  });
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).message || "";
    throw fail(r.status === 422 || r.status === 409 ? 409 : 502, `GitHub ${opts.method || "GET"} ${path}: ${r.status} ${msg}`);
  }
  return r.json();
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = b => Uint8Array.from(atob(b.replace(/\n/g, "")), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const text = (form, key, max = 200) => String(form.get(key) || "").trim().slice(0, max);
const blob = async (env, bytes) => (await gh(env, "/git/blobs", { method: "POST", body: JSON.stringify({ content: b64(bytes), encoding: "base64" }) })).sha;
const json = obj => new TextEncoder().encode(JSON.stringify(obj, null, 2) + "\n");
const readBlob = async (env, sha) => unb64((await gh(env, `/git/blobs/${sha}`)).content);

function fieldsFrom(form) {
  return {
    name: text(form, "name", 80), creator: text(form, "creator", 80), version: text(form, "version", 40) || "1.0.0",
    tags: text(form, "tags", 300), summary: text(form, "summary", 300), about: text(form, "about", 5000),
  };
}

async function zipFrom(form, limit) {
  const file = form.get("file");
  if (!file || typeof file === "string") throw fail(400, "Choose a zip first.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > limit) throw fail(413, `The zip is over the ${limit / 1048576} MB limit.`);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw fail(400, "That file isn't a zip.");
  return bytes;
}

function checkFields(f) {
  if (!f.name || !f.creator) throw fail(400, "Name and creator are required.");
  if (!/^[A-Za-z0-9][\w.\-]{0,79}$/.test(slug(f.name))) throw fail(400, "That name can't be turned into an id. Use letters or numbers.");
}

// One commit on a branch: write/delete paths on top of its current tree.
async function commit(env, branch, tree, message, { create = false } = {}) {
  const ref = await gh(env, `/git/ref/heads/${branch}`, { allow404: create });
  const head = ref ? await gh(env, `/git/commits/${ref.object.sha}`) : null;
  const newTree = await gh(env, "/git/trees", { method: "POST", body: JSON.stringify(head ? { base_tree: head.tree.sha, tree } : { tree }) });
  const c = await gh(env, "/git/commits", { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: ref ? [ref.object.sha] : [] }) });
  if (ref) await gh(env, `/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: c.sha }) });
  else await gh(env, "/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: c.sha }) });
}

// ---------- Store ----------
async function readStore(env) {
  const ref = await gh(env, `/git/ref/heads/${env.BRANCH}`);
  const file = await gh(env, `/contents/manifest.json?ref=${ref.object.sha}`);
  return { head: ref.object.sha, manifest: JSON.parse(new TextDecoder().decode(unb64(file.content))) };
}

async function release(bytes, f, env) {
  checkFields(f);
  const id = slug(f.name);
  const { manifest } = await readStore(env);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  // Keep an existing entry's id (it may differ in case) so updates replace it.
  const prev = manifest.mods.find(m => m.id.toLowerCase() === id || m.name.toLowerCase() === f.name.toLowerCase());
  const modId = prev ? prev.id : id;
  const path = `mods/${modId}/${modId}.zip`;
  const entry = {
    id: modId, name: f.name, creator: f.creator, version: f.version,
    summary: f.summary, description: f.about || f.summary,
    tags: f.tags.split(",").map(t => t.trim()).filter(Boolean),
    updated: now,
    files: [{ name: `${modId}.zip`, url: path, bytes: bytes.length, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) }],
  };
  const mods = manifest.mods.filter(m => m !== prev);
  if (prev) mods.splice(manifest.mods.indexOf(prev), 0, entry); else mods.push(entry);

  const tree = [
    { path, mode: "100644", type: "blob", sha: await blob(env, bytes) },
    { path: "manifest.json", mode: "100644", type: "blob", sha: await blob(env, json({ ...manifest, updated: now, mods })) },
  ];
  // Drop the old zip if an earlier entry lived at a different path.
  const oldUrl = prev?.files?.[0]?.url;
  if (oldUrl && oldUrl !== path) tree.push({ path: oldUrl, mode: "100644", type: "blob", sha: null });
  await commit(env, env.BRANCH, tree, `${prev ? "Update" : "Add"} ${f.name} ${f.version}`);
  return { ok: true, updated: !!prev, entry, mods };
}

async function remove(id, env) {
  const { manifest } = await readStore(env);
  const prev = manifest.mods.find(m => m.id === id);
  if (!prev) throw fail(404, "That mod isn't in the store any more.");
  const mods = manifest.mods.filter(m => m !== prev);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const tree = [{ path: "manifest.json", mode: "100644", type: "blob", sha: await blob(env, json({ ...manifest, updated: now, mods })) }];
  // Delete the zip only if the store hosts it and no other entry still uses it.
  for (const f of prev.files || [])
    if (f.url && !/^https?:/i.test(f.url) && !mods.some(m => (m.files || []).some(o => o.url === f.url)) && await gh(env, `/contents/${f.url}?ref=${env.BRANCH}`, { allow404: true }))
      tree.push({ path: f.url, mode: "100644", type: "blob", sha: null });
  await commit(env, env.BRANCH, tree, `Remove ${prev.name}`);
  return { ok: true, mods };
}

// ---------- Submissions queue ----------
// Each submission is pending/<id>/mod.zip plus pending/<id>/meta.json on the queue branch.
async function readQueue(env) {
  const ref = await gh(env, `/git/ref/heads/${QUEUE}`, { allow404: true });
  if (!ref) return { items: [] };
  const head = await gh(env, `/git/commits/${ref.object.sha}`);
  const tree = await gh(env, `/git/trees/${head.tree.sha}?recursive=1`);
  const files = Object.fromEntries(tree.tree.filter(t => t.type === "blob").map(t => [t.path, t.sha]));
  const ids = Object.keys(files).map(p => p.match(/^pending\/([^/]+)\/meta\.json$/)?.[1]).filter(Boolean);
  const items = await Promise.all(ids.filter(id => files[`pending/${id}/mod.zip`]).map(async id => ({
    ...JSON.parse(new TextDecoder().decode(await readBlob(env, files[`pending/${id}/meta.json`]))),
    id, zipSha: files[`pending/${id}/mod.zip`],
  })));
  items.sort((a, b) => (a.submitted < b.submitted ? -1 : 1));
  return { items };
}

async function submit(form, env) {
  const bytes = await zipFrom(form, GUEST_LIMIT);
  const f = fieldsFrom(form);
  checkFields(f);
  if ((await readQueue(env)).items.length >= MAX_PENDING) throw fail(429, "The review queue is full right now. Try again later.");
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const meta = { ...f, bytes: bytes.length, patches: text(form, "patches", 500), submitted: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
  await commit(env, QUEUE, [
    { path: `pending/${id}/mod.zip`, mode: "100644", type: "blob", sha: await blob(env, bytes) },
    { path: `pending/${id}/meta.json`, mode: "100644", type: "blob", sha: await blob(env, json(meta)) },
    // Keeps the branch from ever being empty once every submission is reviewed.
    { path: "README.md", mode: "100644", type: "blob", sha: await blob(env, new TextEncoder().encode("Mod submissions waiting for review. Managed by the upload page; don't edit by hand.\n")) },
  ], `Submission: ${f.name} ${f.version} by ${f.creator}`, { create: true });
  return { ok: true };
}

async function review(form, env) {
  const id = text(form, "id", 80), action = text(form, "action", 10);
  const { items } = await readQueue(env);
  const item = items.find(s => s.id === id);
  if (!item) throw fail(404, "That submission is gone. Someone may have already reviewed it.");
  let result = { ok: true };
  if (action === "approve") result = await release(await readBlob(env, item.zipSha), item, env);
  else if (action !== "reject") throw fail(400, "Unknown action.");
  await commit(env, QUEUE, [
    { path: `pending/${id}/mod.zip`, mode: "100644", type: "blob", sha: null },
    { path: `pending/${id}/meta.json`, mode: "100644", type: "blob", sha: null },
  ], `${action === "approve" ? "Approved" : "Rejected"}: ${item.name} ${item.version}`);
  return { ...result, submissions: items.filter(s => s.id !== id) };
}
