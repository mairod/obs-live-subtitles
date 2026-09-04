// Sequential FIFO: one translation at a time, so captions always emit in
// spoken order. ponytail: serialization is the ordering mechanism — no
// reordering buffer needed; revisit only if translation becomes the bottleneck.
export function makeCaptionQueue(translate, emit) {
  let chain = Promise.resolve();
  const recent = []; // most recent English translations

  return {
    push(frText) {
      chain = chain.then(async () => {
        try {
          const en = await translate(frText, recent.slice(-3));
          recent.push(en);
          if (recent.length > 10) recent.shift();
          emit(en);
        } catch (err) {
          console.error('translate failed, skipping segment:', err.message);
        }
      });
      return chain;
    },
  };
}
