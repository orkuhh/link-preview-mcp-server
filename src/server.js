import { McpServer, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import fetch from "node-fetch";

const server = new McpServer({
  name: "link-preview-mcp-server",
  version: "1.0.0"
}, {
  capabilities: {}
});

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function getFavicon(url) {
  try {
    const parsedUrl = new URL(url);
    const faviconUrl = `${parsedUrl.origin}/favicon.ico`;
    const response = await fetchWithTimeout(faviconUrl, 3000);
    if (response.ok) {
      return faviconUrl;
    }
  } catch {
    // Ignore favicon errors
  }
  return undefined;
}

async function fetchLinkPreview(url) {
  const response = await fetchWithTimeout(url, 15000);
  const html = await response.text();
  const $ = cheerio.load(html);

  const preview = {
    url,
    contentType: response.headers.get("content-type") || undefined,
    language: $("html").attr("lang") || undefined,
  };

  // OpenGraph meta tags
  $('meta[property^="og:"]').each((_, el) => {
    const property = $(el).attr("property");
    const content = $(el).attr("content");
    if (!property || !content) return;

    switch (property) {
      case "og:title":
        preview.title = content;
        break;
      case "og:description":
        preview.description = content;
        break;
      case "og:image":
        preview.image = content;
        break;
      case "og:site_name":
        preview.siteName = content;
        break;
      case "og:type":
        preview.type = content;
        break;
      case "og:url":
        preview.urlCanonical = content;
        break;
    }
  });

  // Twitter Card meta tags
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr("name");
    const content = $(el).attr("content");
    if (!name || !content) return;

    if (name === "twitter:card") {
      preview.twitterCard = content;
    } else if (name === "twitter:title" && !preview.title) {
      preview.title = content;
    } else if (name === "twitter:description" && !preview.description) {
      preview.description = content;
    } else if (name === "twitter:image" && !preview.image) {
      preview.image = content;
    }
  });

  // Fallback to title/description meta tags
  if (!preview.title) {
    preview.title = $("title").text().trim() || undefined;
  }

  if (!preview.description) {
    $('meta[name="description"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) {
        preview.description = content;
        return false;
      }
    });
  }

  preview.favicon = await getFavicon(url);

  return preview;
}

async function searchWeb(query) {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  const response = await fetchWithTimeout(searchUrl, 10000);
  const html = await response.text();
  const $ = cheerio.load(html);

  const results = [];

  $(".result").each((_, el) => {
    const titleEl = $(el).find(".result__title a");
    const snippetEl = $(el).find(".result__snippet");
    const url = titleEl.attr("href");
    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();

    if (url && title) {
      results.push({ title, url, snippet });
    }
  });

  return results.slice(0, 10);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "fetch_link_preview",
        description:
          "Fetch OpenGraph and social metadata from a URL. Returns structured preview data including title, description, image, site name, and social card info. Useful for generating rich link previews in chats.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch preview data from",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "search_web",
        description:
          "Search the web and return results. Returns titles, URLs, and snippets for quick research or link discovery.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query string",
            },
            numResults: {
              type: "number",
              description: "Number of results to return (default: 10)",
              default: 10,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_page_content",
        description:
          "Extract clean text content from a URL. Returns the main readable text from the page, stripped of navigation and boilerplate. Useful for summarizing articles or extracting key information.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to extract content from",
            },
            maxLength: {
              type: "number",
              description: "Maximum characters to return (default: 5000)",
              default: 5000,
            },
          },
          required: ["url"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "fetch_link_preview") {
      const url = String(args?.url);
      if (!url) throw new Error("URL is required");
      const preview = await fetchLinkPreview(url);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(preview, null, 2),
          },
        ],
      };
    }

    if (name === "search_web") {
      const query = String(args?.query);
      const numResults = Number(args?.numResults) || 10;
      const results = (await searchWeb(query)).slice(0, numResults);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    if (name === "get_page_content") {
      const url = String(args?.url);
      const maxLength = Number(args?.maxLength) || 5000;
      const response = await fetchWithTimeout(url, 15000);
      const html = await response.text();
      const $ = cheerio.load(html);

      $("script, style, nav, header, footer, iframe, noscript, aside").remove();

      let content = $("article").text() || $("main").text() || $("body").text();
      content = content.replace(/\s+/g, " ").trim();
      content = content.slice(0, maxLength);

      return {
        content: [
          {
            type: "text",
            text: content,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Link Preview MCP Server running on stdio");
}

main().catch(console.error);
