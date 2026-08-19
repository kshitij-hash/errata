import { AskSpread } from '../components/ask/AskSpread';
import { HeroBand } from '../components/hero/HeroBand';
import { EvidenceStrip } from '../components/results/EvidenceStrip';

export default function AskPage() {
  return (
    <main className="route">
      {/* The hero band carries the itinerary the tour ribbon used to nag about, in the page's own
          voice and without a dismiss button — so the ribbon is no longer mounted here. */}
      <HeroBand />
      <EvidenceStrip />
      {/* h2, not h1: the hero headline above is now the page's heading, and two h1s on one route
          is a defect a screen reader hears before anyone else does. */}
      <h2 className="rtitle" id="ask">
        Ask the memory
      </h2>
      <AskSpread />
    </main>
  );
}
