import { TourRibbon } from '../components/TourRibbon';
import { AskSpread } from '../components/ask/AskSpread';
import { EvidenceStrip } from '../components/results/EvidenceStrip';

export default function AskPage() {
  return (
    <>
      <TourRibbon />
      <main className="route">
        <EvidenceStrip />
        <h1 className="rtitle">Ask the memory</h1>
        <AskSpread />
      </main>
    </>
  );
}
