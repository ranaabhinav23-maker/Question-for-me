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
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const { pageId } = await request.json();
      if (!pageId) return new Response(JSON.stringify({ error: 'No pageId provided' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const NOTION_TOKEN = env.NOTION_TOKEN;

      // Fetch page metadata
      const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        }
      });
      const pageData = await pageRes.json();
      const title = pageData.properties?.title?.title?.[0]?.plain_text
        || pageData.properties?.Name?.title?.[0]?.plain_text
        || 'Imported Note';

      // Fetch all blocks (page content)
      let blocks = [];
      let cursor = undefined;
      do {
        const url = `https://api.notion.com/v1/blocks/${pageId}/children${cursor ? '?start_cursor=' + cursor : ''}`;
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
          }
        });
        const data = await res.json();
        blocks = blocks.concat(data.results || []);
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);

      // Convert blocks to HTML
      const html = blocksToHtml(blocks);

      return new Response(JSON.stringify({ title, html }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

function blocksToHtml(blocks) {
  return blocks.map(block => {
    const type = block.type;
    const getText = (richText) => (richText || []).map(t => {
      let text = t.plain_text || '';
      if (t.annotations?.bold) text = `<strong>${text}</strong>`;
      if (t.annotations?.italic) text = `<em>${text}</em>`;
      if (t.annotations?.underline) text = `<u>${text}</u>`;
      if (t.annotations?.code) text = `<code>${text}</code>`;
      return text;
    }).join('');

    switch (type) {
      case 'heading_1': return `<h1>${getText(block.heading_1.rich_text)}</h1>`;
      case 'heading_2': return `<h2>${getText(block.heading_2.rich_text)}</h2>`;
      case 'heading_3': return `<h3>${getText(block.heading_3.rich_text)}</h3>`;
      case 'paragraph': return `<p>${getText(block.paragraph.rich_text)}</p>`;
      case 'bulleted_list_item': return `<li>${getText(block.bulleted_list_item.rich_text)}</li>`;
      case 'numbered_list_item': return `<li>${getText(block.numbered_list_item.rich_text)}</li>`;
      case 'toggle': return `<p><strong>${getText(block.toggle.rich_text)}</strong></p>`;
      case 'quote': return `<blockquote>${getText(block.quote.rich_text)}</blockquote>`;
      case 'callout': return `<p>💡 ${getText(block.callout.rich_text)}</p>`;
      case 'divider': return `<hr>`;
      case 'table_of_contents': return '';
      default: return '';
    }
  }).join('\n');
}
