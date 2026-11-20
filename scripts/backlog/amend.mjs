// When a backlog write folds into dev's HEAD instead of adding a commit, and
// the messages either way. Pure: backlog.mjs gathers the facts from git.
//
// Every backlog commit ends with trailers the tool writes and nothing else
// does:
//   Backlog-Tool: <command>     one line per write the commit holds
//   Backlog-Ids: B-1, B-2       every id those writes covered (when any)
// A write amends HEAD only when every guard in shouldAmend holds; any doubt
// means a new commit.

export const TOOL_TRAILER = "Backlog-Tool";
export const IDS_TRAILER = "Backlog-Ids";
export const PREFIX = "chore(backlog): ";
/** HEAD must be younger than this to be amended. */
export const WINDOW_MS = 10 * 60 * 1000;
const SUBJECT_MAX = 72;

/**
 * @typedef {object} AmendFacts
 * @property {boolean} trailer HEAD is a backlog commit (the subject prefix and the tool's trailers)
 * @property {boolean} singleParent HEAD has exactly one parent
 * @property {boolean} onlyBacklogFiles HEAD changes only the backlog's files
 * @property {boolean} rewritten HEAD's author and committer times differ (amended or rebased by hand)
 * @property {number} commitTime HEAD's committer time, in ms
 * @property {number} now in ms
 * @property {boolean} containedElsewhere another ref (a local branch, remote-tracking ref, tag or
 *   stash) or a detached worktree contains HEAD
 * @property {boolean} moved HEAD isn't the commit read at the start of the write
 * @property {boolean} referenced an item's commit field names HEAD
 */

/**
 * "amend" only when every guard holds; anything missing or odd is "new".
 * @param {Partial<AmendFacts>} f
 * @returns {"amend" | "new"}
 */
export function shouldAmend(f) {
  if (f.trailer !== true || f.singleParent !== true || f.onlyBacklogFiles !== true) return "new";
  if (f.rewritten !== false || f.referenced !== false) return "new";
  if (f.containedElsewhere !== false || f.moved !== false) return "new";
  if (!Number.isFinite(f.commitTime) || !Number.isFinite(f.now)) return "new";
  const age = /** @type {number} */ (f.now) - /** @type {number} */ (f.commitTime);
  return age >= 0 && age < WINDOW_MS ? "amend" : "new";
}

/** "B-1, B-2, B-3 +2": the ids, shortened past three. @param {string[]} ids */
export const idList = (ids) =>
  ids.length <= 3 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} +${ids.length - 3}`;

/**
 * One write: `tool` is the command, `ids` the items it covered, `text` what
 * goes after the prefix in its subject, `lines` its body lines.
 * @typedef {{ tool: string, ids: string[], text: string, lines: string[] }} Write
 */

const subjectOf = (text) => `${PREFIX}${text}`.slice(0, SUBJECT_MAX);
const trailers = (tools, ids) => [
  ...tools.map((t) => `${TOOL_TRAILER}: ${t}`),
  ...(ids.length ? [`${IDS_TRAILER}: ${ids.join(", ")}`] : []),
];
const unique = (xs) => [...new Set(xs)];

/** The message of a commit holding one write. @param {Write} w */
export function writeMessage(w) {
  const ids = unique(w.ids);
  return [subjectOf(w.text), w.lines.join("\n"), trailers([w.tool], ids).join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A commit message, read back. `tools` is empty unless it's a backlog
 * commit. `blocks` are its writes' descriptions (text, then body lines).
 * @param {string} raw
 */
export function parseMessage(raw) {
  const [subject = "", ...rest] = raw.replace(/\s+$/, "").split("\n");
  const paragraphs = rest
    .join("\n")
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean);
  const last = (paragraphs.at(-1) ?? "").split("\n");
  const re = new RegExp(`^(${TOOL_TRAILER}|${IDS_TRAILER}): (.*)$`);
  const isTrailers = last.length > 0 && last.every((l) => re.test(l));
  /** @type {string[]} */
  const tools = [];
  /** @type {string[]} */
  const ids = [];
  if (isTrailers)
    for (const l of last) {
      const [, key, value] = /** @type {RegExpExecArray} */ (re.exec(l));
      if (key === TOOL_TRAILER) tools.push(value.trim());
      else
        ids.push(
          ...value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
    }
  const body = isTrailers ? paragraphs.slice(0, -1) : paragraphs;
  const backlog = subject.startsWith(PREFIX) && tools.length > 0;
  const blocks = backlog && tools.length === 1 ? [[subject.slice(PREFIX.length), ...body].join("\n")] : body;
  return { subject, backlog, tools: backlog ? tools : [], ids: backlog ? unique(ids) : [], blocks };
}

/**
 * The message of HEAD with one more write folded in: the subject lists every
 * id (and the commands), the body keeps each write's lines.
 * @param {string} headRaw @param {Write} w
 */
export function amendedMessage(headRaw, w) {
  const prev = parseMessage(headRaw);
  const tools = [...prev.tools, w.tool];
  const ids = unique([...prev.ids, ...w.ids]);
  const commands = unique(tools).join(", ");
  const blocks = [...prev.blocks, [w.text, ...w.lines].join("\n")];
  return [
    subjectOf(ids.length ? `${idList(ids)}: ${commands}` : commands),
    blocks.join("\n\n"),
    trailers(tools, ids).join("\n"),
  ].join("\n\n");
}
