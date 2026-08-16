import type { Metadata } from 'next';
import { TimelinePanel } from '../../components/timeline/TimelinePanel';

export const metadata: Metadata = {
  title: 'Timeline',
  description: 'The belief over time: the ledger chain, every strike an edge, nothing deleted.',
};

export default function TimelinePage() {
  return (
    <main className="route">
      <h1 className="rtitle">The belief, over time</h1>
      <TimelinePanel />
    </main>
  );
}
