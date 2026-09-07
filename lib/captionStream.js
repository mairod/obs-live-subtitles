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
  let finalizing = false; // an authoritative translation is running
  let gen = 0;            // bumped on commit; invalidates in-flight stream output
  let abort = null;
  const recent = [];      // committed English, as translation context

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
        inFlight = false;
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

    async onCommit(text) {
      const fr = text?.trim();
      if (!fr) return;

      gen++;            // any in-flight provisional output is now stale
      abort?.abort();
      pendingFr = null;
      finalizing = true;

      try {
        let en;
        if (lastGood && lastGood.fr === fr) {
          en = lastGood.en; // already on screen — no call, and no wobble
        } else {
          en = await translate(fr, recent.slice(-3));
        }
        recent.push(en);
        if (recent.length > 10) recent.shift();
        emit({ text: en, final: true });
      } catch (err) {
        console.error('translate failed, skipping segment:', err.message);
      } finally {
        lastGood = null; // next partial starts a new block
        finalizing = false;
        pump();
      }
    },
  };
}
