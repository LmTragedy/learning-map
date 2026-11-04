// Display-only split of the stored summary ("AI解释：…验收：…本地图仅依据…"); the stored text is unchanged.

/** Clauses written for the author or the AI (extraction quality, made-up example data), not for the learner. */
const CAVEAT = /排版(有|受)?损|提取(文本|文字)|识别(可能)?不确定|公式(和表格)?未核对|课件假设|假设例子|本身存疑|需对照原页/;

/** Cuts caveat clauses out of one paragraph; the clause punctuation stays with the text it belongs to. */
function takeCaveats(text: string, caveats: string[]) {
  // Clauses end at 。；; or at a comma that starts an aside such as "，是课件假设例子。".
  const kept = text.split(/(?<=[。；;])/).map((sentence) => {
    if (!CAVEAT.test(sentence)) return sentence;
    const comma = sentence.split(/(?=[，,])/);
    const head = comma.filter((piece) => !CAVEAT.test(piece));
    const tail = comma.filter((piece) => CAVEAT.test(piece));
    tail.forEach((piece) => caveats.push(piece.replace(/^[，,]\s*/, "").replace(/[。；;]$/, "").trim()));
    if (!head.length) return "";
    const end = /[。；;]$/.test(sentence) ? sentence.slice(-1) : "";
    return head.join("").replace(/[，,]\s*$/, "") + (/[。；;]$/.test(head.join("")) ? "" : end);
  });
  return kept.join("").trim();
}

export function splitSummary(summary: string) {
  const text = summary.trim();
  const noteAt = text.search(/本地图仅依据|本地图依据|原文见\s*sources/);
  const body = noteAt > 0 ? text.slice(0, noteAt) : text;
  const note = noteAt > 0 ? text.slice(noteAt) : "";
  const checkAt = body.search(/验收[：:]/);
  const caveats: string[] = [];
  const explain = takeCaveats((checkAt >= 0 ? body.slice(0, checkAt) : body).replace(/^AI\s*解释[：:]\s*/, "").trim(), caveats);
  const check = takeCaveats(checkAt >= 0 ? body.slice(checkAt).replace(/^验收[：:]\s*/, "").trim() : "", caveats);
  return { explain, check, note, caveats: caveats.filter(Boolean) };
}
