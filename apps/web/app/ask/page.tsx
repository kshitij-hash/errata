import type { Metadata } from 'next';
import { AskSpread } from '../../components/ask/AskSpread';
import { EvidenceStrip } from '../../components/results/EvidenceStrip';

export const metadata: Metadata = { title: 'Ask' };

export default function AskPage() {
  return (
    <main className="route">
      <h1 className="rtitle" id="ask">
        Ask the memory
      </h1>
      <AskSpread />
      <EvidenceStrip />
    </main>
  );
}
