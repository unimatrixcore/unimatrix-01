# Document text

```ts
import { convertHtmlDocument } from "@unimatrix/document-text";

const request = {
  html: "<h2>Reading</h2><p>Read <a href='../files/2'>chapter two</a>.</p>",
  baseUrl: "https://school.example/courses/42/pages/intro",
  maxOutputCharacters: 16_000,
};
const first = convertHtmlDocument(request);
const next = first.continuation
  ? convertHtmlDocument({ ...request, continuation: first.continuation })
  : null;
```

Supply the same HTML and base URL for continuation. Offsets count Unicode code points;
concatenate slices in order before rendering Markdown because a slice can end inside a link,
table or code fence. `truncated` and `continuation` describe the returned slice; `totalCharacters`
describes the complete conversion. The document identifier binds continuation to the supplied
HTML, source URL and converter version. It provides consistency, not authorization; callers must
authorize access to the source separately.

`DOCUMENT_TEXT_LIMITS` defines input, slice and conversion budgets. Oversized UTF-8 input is
rejected before parsing, as is markup exceeding the marker budget; intermediate rule output
also consumes the conversion budget. A `DocumentTextError` carries a stable code without
echoing supplied text. Pathological nesting
that exceeds the parser/converter's capacity fails explicitly instead of returning partial text.

Links resolve against the explicit base URL. Only HTTP(S) destinations without user information
survive; image alt text survives without its image URL. Tables use Markdown rows, preserving
captions, inline content and explicit span annotations; multiline cells become single lines.
Code in table cells is split at pipes to preserve its visible text; the pipe itself is outside
the code span. Literal HTML characters and pipes in ordinary text use character entities.

Conversion operates on supplied content without fetching URLs, loading credentials, executing
scripts or downloading images. Treat every result as untrusted course data. Executable/embedded
HTML removal does not establish prompt-injection safety. Render with a safe Markdown renderer;
never execute the result as HTML or instructions.
