// Blog admin API (Cloudflare Pages Function).
// Commits posts/images to GitHub; the Pages git integration rebuilds the site.
// Secrets: ADMIN_PASSWORD, GITHUB_TOKEN (fine-grained, Contents read/write on the repo).

const REPO = 'clscls25/chirpskateweb';
const BRANCH = 'master';
const POSTS_DIR = 'src/content/posts';
const IMAGES_DIR = 'public/blog-images';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function onRequest({ request, env, params }) {
  if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN) {
    return json({ error: 'Server not configured (missing ADMIN_PASSWORD or GITHUB_TOKEN)' }, 500);
  }
  if (!(await authorized(request, env.ADMIN_PASSWORD))) {
    await new Promise(r => setTimeout(r, 750));
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = params.path || [];
  const method = request.method;
  const gh = github(env.GITHUB_TOKEN);

  try {
    if (path[0] === 'login' && method === 'POST') return json({ ok: true });

    if (path[0] === 'posts' && path.length === 1 && method === 'GET') {
      const files = await gh.list(POSTS_DIR);
      const posts = await Promise.all(
        files.filter(f => f.name.endsWith('.md')).map(async f => {
          const { text } = await gh.get(f.path);
          const { data } = parsePost(text);
          return { slug: f.name.replace(/\.md$/, ''), ...data };
        })
      );
      posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return json({ posts });
    }

    if (path[0] === 'posts' && path.length === 2) {
      const slug = path[1];
      if (!SLUG_RE.test(slug)) return json({ error: 'Invalid slug' }, 400);
      const filePath = `${POSTS_DIR}/${slug}.md`;

      if (method === 'GET') {
        const file = await gh.get(filePath);
        if (!file) return json({ error: 'Not found' }, 404);
        const { data, body } = parsePost(file.text);
        return json({ slug, sha: file.sha, data, body });
      }

      if (method === 'PUT') {
        const { data, body, sha } = await request.json();
        if (!data?.title?.trim()) return json({ error: 'Title is required' }, 400);
        if (!data?.description?.trim()) return json({ error: 'Description is required' }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data?.date || '')) return json({ error: 'Date must be YYYY-MM-DD' }, 400);
        if (!sha && (await gh.get(filePath))) {
          return json({ error: `A post with the URL "${slug}" already exists` }, 409);
        }
        const text = serializePost(data, body || '');
        const verb = sha ? 'Update' : 'Add';
        const res = await gh.put(filePath, utf8ToBase64(text), `${verb} post: ${data.title}`, sha);
        return json({ ok: true, sha: res.content.sha });
      }

      if (method === 'DELETE') {
        const { sha } = await request.json();
        await gh.del(filePath, `Delete post: ${slug}`, sha);
        return json({ ok: true });
      }
    }

    if (path[0] === 'images' && method === 'POST') {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return json({ error: 'No file' }, 400);
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return json({ error: 'Use PNG, JPG, GIF or WebP' }, 400);
      if (file.size > MAX_IMAGE_BYTES) return json({ error: 'Image must be under 5 MB' }, 400);
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type];
      const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
      const name = `${new Date().toISOString().slice(0, 10)}-${base}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await gh.put(`${IMAGES_DIR}/${name}`, bytesToBase64(bytes), `Add blog image ${name}`);
      return json({ ok: true, url: `/blog-images/${name}` });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}

async function authorized(request, password) {
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(password)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function github(token) {
  const base = `https://api.github.com/repos/${REPO}/contents`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'chirpskate-blog-admin',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}/${path}${init.method ? '' : `?ref=${BRANCH}`}`, { ...init, headers });
    if (res.status === 404 && !init.method) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = res.status === 409 || res.status === 422
        ? 'This post changed since you opened it. Reload it and try again.'
        : `GitHub ${res.status}: ${body.message || 'request failed'}`;
      throw Object.assign(new Error(msg), { status: res.status === 409 || res.status === 422 ? 409 : 502 });
    }
    return body;
  };
  return {
    list: async dir => (await call(dir)) || [],
    get: async path => {
      const f = await call(path);
      return f && { sha: f.sha, text: base64ToUtf8(f.content) };
    },
    put: (path, content, message, sha) =>
      call(path, { method: 'PUT', body: JSON.stringify({ message, content, branch: BRANCH, ...(sha && { sha }) }) }),
    del: (path, message, sha) =>
      call(path, { method: 'DELETE', body: JSON.stringify({ message, sha, branch: BRANCH }) }),
  };
}

// Frontmatter: only the flat scalar keys the content schema uses.
function parsePost(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (v.startsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    else if (v === 'true' || v === 'false') v = v === 'true';
    data[kv[1]] = v;
  }
  return { data, body: m[2].replace(/^\r?\n/, '') };
}

function serializePost(data, body) {
  const lines = [
    `title: ${JSON.stringify(data.title.trim())}`,
    `description: ${JSON.stringify(data.description.trim())}`,
    `date: ${data.date}`,
    `author: ${JSON.stringify((data.author || 'Chirp Skate').trim())}`,
  ];
  if (data.draft) lines.push('draft: true');
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/\r\n/g, '\n').trim()}\n`;
}

function utf8ToBase64(str) { return bytesToBase64(new TextEncoder().encode(str)); }
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
