import { describe, expect, test } from "vitest";
import { sanitizeWecomReplyText } from "./reply-sanitize.js";

describe("sanitizeWecomReplyText", () => {
  test("converts markdown into readable plain text while removing links by default", () => {
    const input = `
# Summary

**Done**:
- first item
- second item

See [docs](https://example.com/docs) and \`openclaw status\`.

\`\`\`bash
echo hi
\`\`\`
`;

    expect(sanitizeWecomReplyText(input, false)).toBe(
      "Summary\n\nDone:\n- first item\n- second item\n\nSee docs and openclaw status.\n\necho hi",
    );
  });

  test("keeps links in readable text form instead of markdown", () => {
    const input = "参考 [文档](https://example.com/docs) 和 ![截图](https://example.com/a.png)";

    expect(sanitizeWecomReplyText(input, true)).toBe(
      "参考 文档: https://example.com/docs 和 截图: https://example.com/a.png",
    );
  });

  test("strips trailing source footer blocks without touching the main body", () => {
    const input = `
结论先说：可以这样做。

执行步骤：
1. 打开控制台
2. 检查配置

  我用到的来源
<https://example.com/a>
<https://example.com/b>
`;

    expect(sanitizeWecomReplyText(input, false)).toBe(
      "结论先说：可以这样做。\n\n执行步骤：\n1. 打开控制台\n2. 检查配置",
    );
  });

  test("strips markdown source footer blocks before markdown rendering", () => {
    const input = `
# 结论

正文保留。

我用到的来源
- [路透社](https://example.com/reuters)
- [彭博](https://example.com/bloomberg)
`;

    expect(sanitizeWecomReplyText(input, false)).toBe("结论\n\n正文保留。");
  });

  test("keeps body text that mentions 来源 when it is not a trailing citation block", () => {
    const input = "这个结论的来源是你刚才提供的数据，不需要再查网页。";

    expect(sanitizeWecomReplyText(input, false)).toBe(
      "这个结论的来源是你刚才提供的数据，不需要再查网页。",
    );
  });
});
