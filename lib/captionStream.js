// Turns a stream of French partial/committed transcripts into an ordered
// stream of English caption updates.
//
// Two lanes. The provisional lane streams a translation of the newest partial
// and never waits for VAD — that is where the latency win comes from. The
// authoritative lane runs on commit and locks the block.
//
// ponytail: newest-wins, not FIFO. Intermediate partials are worthless once a
// newer one exists, so they are dropped rather than queued.
export function makeCaptionStream({ translateStream, translate, emit }) {
  let pendingFr = null;   // newest partial awaiting translation
  let lastGood = null;    // { fr, en } of the last COMPLETED provisional
  let inFlight = false;   // a provisional stream is running
  let finalizing = false; // one or more authoritative translations are running
  let gen = 0;            // bumped on commit; invalidates in-flight stream output
  let abort = null;
  const recent = [];      // committed English, as translation context

  // ponytail: serialises commits so final: true always lands in spoken order.
  // First commit runs immediately (async body starts synchronously, which
  // preserves the call-site timing the tests rely on). Subsequent concurrent
  // commits are chained onto the promise so they wait their turn.
  // queuedCommits tracks depth so finalizing releases only on the last.
  let commitChain = Promise.resolve();
  let queuedCommits = 0;

  function pump() {
    // finalizing holds the lane so a final: true can never land after the
    // next block's provisional text.
    if (inFlight || finalizing || pendingFr === null) return;

    const fr = pendingFr;
    pendingFr = null;
    inFlight = true;
    const myGen = gen;
    const ctl = new AbortController();
    abort = ctl;

    translateStream(
      fr,
      recent.slice(-3),
      (accumulated) => {
        if (myGen === gen) emit({ text: accumulated, final: false });
      },
      ctl.signal,
    )
      .then((en) => {
        if (myGen !== gen) return; // a commit superseded this stream
        lastGood = { fr, en };
        emit({ text: en, final: false });
      })
      .catch((err) => {
        // A commit aborting us is expected; anything else is worth a line.
        if (myGen === gen) console.error('provisional translate failed:', err.message);
      })
      .finally(() => {
        // ponytail: a superseded stream may still be running — we gave up lane
        // ownership at commit time, so it must not clear the new stream's flag.
        // Ceiling: at most one extra in-flight request, which is what
        // newest-wins implies. Its output is already dropped by the gen checks.
        if (myGen === gen) inFlight = false;
        if (abort === ctl) abort = null;
        pump(); // self-clocking: pick up whatever the newest partial is now
      });
  }

  return {
    onPartial(text) {
      const fr = text?.trim();
      if (!fr) return;
      // Coalesce. Aborting here would restart the stream faster than it can
      // finish (partials ~150ms, translation ~300ms) and nothing would render.
      pendingFr = fr;
      pump();
    },

    // Fire-and-forget from the WS handler, so two commits can arrive inside one
    // translation round-trip. Synchronous entry work happens now; the emit is
    // serialized on commitChain so final: true always lands in spoken order.
    //
    // The first commit body runs immediately (async call executes up to its
    // first await inline), so callers that await onCommit() and then call
    // releaseFinal() work as before. Subsequent overlapping commits chain onto
    // commitChain and wait their turn.
    onCommit(text) {
      const fr = text?.trim();
      gen++;              // any in-flight provisional output is now stale
      abort?.abort();
      abort = null;
      inFlight = false;   // give up lane ownership immediately so a zombie
                          // stream cannot hold inFlight = true forever
      pendingFr = null;
      finalizing = true;
      queuedCommits++;

      const body = async () => {
        try {
          if (!fr) return; // empty commit: reset the block, nothing to emit
          const en = lastGood && lastGood.fr === fr
            ? lastGood.en   // already on screen — no call, and no wobble
            : await translate(fr, recent.slice(-3));
          recent.push(en);
          if (recent.length > 10) recent.shift();
          emit({ text: en, final: true });
        } catch (err) {
          console.error('translate failed, skipping segment:', err.message);
        } finally {
          lastGood = null; // next partial starts a new block
          if (--queuedCommits === 0) {
            finalizing = false;
            pump();
          }
        }
      };

      // First commit: call body() immediately so translate() is invoked
      // before onCommit() returns — tests that rely on this timing continue
      // to work. Concurrent commits (queuedCommits > 1) chain behind the
      // running one to preserve spoken order.
      if (queuedCommits === 1) {
        commitChain = body();
      } else {
        commitChain = commitChain.then(body);
      }
      return commitChain;
    },
  };
}
