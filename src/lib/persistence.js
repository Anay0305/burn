import { fileStateStore } from './db.js';

// Stage each source's events separately while it reads asynchronously. Only
// complete source batches reach SQLite or the visible store. Concurrent
// tailers cannot accidentally commit another source's uncheckpointed events.
export function sourcePersistence(store, db) {
  const files = fileStateStore(db);
  return {
    load: files.load,
    save(path, offset, extra) {
      const batch = store.sourceBatches.getStore();
      if (!batch) throw new Error('Source checkpoint requires a batch');
      batch.checkpoints.push({ path, offset, extra });
    },
    batch(work) {
      const batch = { events: [], checkpoints: [] };
      const commit = () => {
        if (batch.events.length && !batch.checkpoints.length) throw new Error('Source events require a checkpoint');
        db.exec('BEGIN');
        try {
          store.writeEvents(batch.events);
          for (const c of batch.checkpoints) files.save(c.path, c.offset, c.extra);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        for (const event of batch.events) store.add(event, { fromDb: true });
      };
      return store.sourceBatches.run(batch, () => {
        const result = work();
        if (result?.then) return result.then((value) => { commit(); return value; });
        commit();
        return result;
      });
    },
  };
}
