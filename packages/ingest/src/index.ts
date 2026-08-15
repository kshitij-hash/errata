// @errata/ingest — pipeline CLI + LongMemEval reader.
import { version as core } from '@errata/core';
import { version as graph } from '@errata/graph';
import { version as llm } from '@errata/llm';

export const version = '0.0.0';
export const dependsOn = { core, graph, llm } as const;
