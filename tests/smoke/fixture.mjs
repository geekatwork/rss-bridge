import { createServer } from "node:http";

createServer((req, res) => {
  if (req.url !== "/") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html><head><title>Local smoke fixture</title><link rel="icon" href="data:,"></head>
<body><article>
<h2>Smoke fixture post</h2>
<span class="author">Smoke Tester</span>
<div class="content">Content extracted from the local smoke fixture.</div>
<a href="http://fixture:8080/posts/smoke-test-post">Read more</a>
<time datetime="2026-01-01T12:00:00Z">January 1</time>
</article></body></html>`);
}).listen(8080, "0.0.0.0");
