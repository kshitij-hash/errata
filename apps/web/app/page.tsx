import { TourRibbon } from '../components/TourRibbon';
import { AskSpread } from '../components/ask/AskSpread';

export default function AskPage() {
  return (
    <>
      <TourRibbon />
      <main className="route">
        <h1 className="rtitle">Ask the memory</h1>
        <AskSpread />
      </main>
    </>
  );
}
