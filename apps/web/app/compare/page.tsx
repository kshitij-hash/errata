import type { Metadata } from 'next';
import { Duel } from '../../components/compare/Duel';

export const metadata: Metadata = {
  title: 'Compare',
  description: 'Similarity vs. relevance — what a vector store retrieves, and what a belief graph believes.',
};

export default function ComparePage() {
  return (
    <main className="route">
      <h1 className="rtitle">Similarity vs. relevance</h1>
      <Duel />
    </main>
  );
}
