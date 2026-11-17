const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { setTimeout: pause } = require("node:timers/promises");

const missing = (error) => error.code === "ENOENT" || error.code === "ENOTDIR";
const sameVersion = (left, right) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]);

// A stream can otherwise hash a mixture of two saves, or finish reading an old
// inode after an atomic replacement. Verify both the open file and its path;
// access time is deliberately excluded because reading changes it.
module.exports = async function fingerprint(filePath, signal) {
  while (true) {
    signal?.throwIfAborted();
    let file;
    try {
      file = await fs.promises.open(filePath, "r");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      signal?.throwIfAborted();
      const before = await file.stat({ bigint: true });
      signal?.throwIfAborted();
      const hash = createHash("sha256");
      const stream = file.createReadStream({ signal, autoClose: false });
      // The abort listener may destroy the stream before async iteration has
      // attached, or after it has unwound. Own that event for the full stream
      // lifetime; the iterator still rejects and the handle closes below.
      stream.on("error", () => {});
      for await (const chunk of stream) hash.update(chunk);
      const after = await file.stat({ bigint: true });
      let current;
      try {
        current = await fs.promises.stat(filePath, { bigint: true });
      } catch (error) {
        if (!missing(error)) throw error;
      }
      signal?.throwIfAborted();
      if (current && sameVersion(before, after) && sameVersion(after, current))
        return hash.digest("hex");
    } finally {
      await file.close();
    }
    // Yield between conflicting versions while remaining cancellable if a
    // source is continuously rewritten or its owner has already disappeared.
    await pause(10, undefined, { signal });
  }
};
