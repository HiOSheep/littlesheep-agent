﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// @littlesheep/memory-core — public API

export { MemoryStore, type MemoryStoreOptions, formatDate, daysAgo } from './store.js';
export { buildRecentPrelude, type PreludeOptions } from './prelude.js';
export { searchMemory, isRipgrepAvailable } from './search.js';
export { distillDailyToMemory, markDistilled } from './distill.js';
export { archiveOldMemories, type ArchiveOptions, type ArchiveResult } from './archive.js';
export { VectorIndexedMemoryStore } from './vector-decorator.js';
export { atomicWrite } from './atomic-write.js';
export { createWriteMemoryTool, type WriteMemoryToolDeps } from './write-memory.js';
