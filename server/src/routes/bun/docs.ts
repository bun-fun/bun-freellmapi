import { openapiSpec } from '../../docs/openapi.js';
import { DOCS_HTML } from '../../docs/docs-page.js';

// Static, unauthenticated API reference for the public /v1 surface.
// GET /v1/openapi.json — the OpenAPI 3.0 spec (served as JSON)
// GET /v1/docs       — a self-contained viewer that renders that spec

export function openapiRoute(): Response {
  return new Response(JSON.stringify(openapiSpec), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export function docsRoute(): Response {
  return new Response(DOCS_HTML, {
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
