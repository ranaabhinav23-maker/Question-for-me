export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {

      // ── /api/generate — Claude API ──────────────────────────────────
      if (path === '/api/generate' || path === '/') {
        const body = await request.json();

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: body.model || 'claude-haiku-4-5-20251001',
            max_tokens: body.max_tokens || 4000,
            messages: body.messages,
          }),
        });

        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ── /notion — Notion import ─────────────────────────────────────
      if (path === '/notion') {
        const { pageId, mode } = await request.json();
        const notionHeaders = {
          'Authorization': `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        };

        // mode: database — list all rows
        if (mode === 'database') {
          const res = await fetch(`https://api.notion.com/v1/databases/${pageId}/query`, {
            method: 'POST',
            headers: notionHeaders,
            body: JSON.stringify({ page_size: 100 }),
          });
          const data = await res.json();
          if (data.object === 'error') throw new Error(data.message);

          const rows = (data.results || []).map(page => {
            const props = page.properties || {};
            let title = 'Untitled';
            for (const key of Object.keys(props)) {
              if (props[key].type === 'title') {
                title = props[key].title?.map(t => t.plain_text).join('') || 'Untitled';
                break;
              }
            }
            const meta = {};
            for (const [key, val] of Object.entries(props)) {
              if (val.type === 'rich_text') meta[key] = val.rich_text?.map(t => t.plain_text).join('') || '';
              if (val.type === 'select') meta[key] = val.select?.name || '';
              if (val.type === 'multi_select') meta[key] = val.multi_select?.map(s => s.name).join(', ') || '';
              if (val.type === 'date') meta[key] = val.date?.start || '';
              if (val.type === 'url') meta[key] = val.url || '';
            }
            return { id: page.id, title, meta };
          });

          return new Response(JSON.stringify({ rows }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // mode: page — fetch full content of one page
        const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: notionHeaders });
        const pageData = await pageRes.json();
        if (pageData.object === 'error') throw new Error(pageData.message);

        const props = pageData.properties || {};
        let title = 'Imported Note';
        for (const key of Object.keys(props)) {
          if (props[key].type === 'title') {
            title = props[key].title?.map(t => t.plain_text).join('') || 'Imported Note';
            break;
          }
        }

        // Fetch all blocks with pagination
        let blocks = [];
        let cursor = undefined;
        do {
          const blockUrl = `https://api.notion.com/v1/blocks/${pageId}/children${cursor ? '?start_cursor=' + cursor : ''}`;
          const res = await fetch(blockUrl, { headers: notionHeaders });
          const data = await res.json();
          blocks = blocks.concat(data.results || []);
          cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);

        const html = blocksToHtml(blocks);

        return new Response(JSON.stringify({ title, html }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }
};

function blocksToHtml(blocks) {
  let html = '';
  let inUl = false;
  let inOl = false;

  for (const block of blocks) {
    const type = block.type;
    const getText = (richText) => (richText || []).map(t => {
      let text = t.plain_text || '';
      if (t.annotations?.bold) text = `<strong>${text}</strong>`;
      if (t.annotations?.italic) text = `<em>${text}</em>`;
      if (t.annotations?.underline) text = `<u>${text}</u>`;
      if (t.annotations?.code) text = `<code>${text}</code>`;
      return text;
    }).join('');

    if (type !== 'bulleted_list_item' && inUl) { html += '</ul>'; inUl = false; }
    if (type !== 'numbered_list_item' && inOl) { html += '</ol>'; inOl = false; }

    switch (type) {
      case 'heading_1':
        html += `<h1>${getText(block.heading_1.rich_text)}</h1>`; break;
      case 'heading_2':
        html += `<h2>${getText(block.heading_2.rich_text)}</h2>`; break;
      case 'heading_3':
        html += `<h3>${getText(block.heading_3.rich_text)}</h3>`; break;
      case 'paragraph':
        const text = getText(block.paragraph.rich_text);
        if (text) html += `<p>${text}</p>`; break;
      case 'bulleted_list_item':
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += `<li>${getText(block.bulleted_list_item.rich_text)}</li>`; break;
      case 'numbered_list_item':
        if (!inOl) { html += '<ol>'; inOl = true; }
        html += `<li>${getText(block.numbered_list_item.rich_text)}</li>`; break;
      case 'toggle':
        html += `<p><strong>${getText(block.toggle.rich_text)}</strong></p>`; break;
      case 'quote':
        html += `<blockquote>${getText(block.quote.rich_text)}</blockquote>`; break;
      case 'callout':
        html += `<p>💡 ${getText(block.callout.rich_text)}</p>`; break;
      case 'divider':
        html += `<hr>`; break;
      case 'code':
        html += `<pre><code>${getText(block.code.rich_text)}</code></pre>`; break;
      default: break;
    }
  }

  if (inUl) html += '</ul>';
  if (inOl) html += '</ol>';

  return html;
}
