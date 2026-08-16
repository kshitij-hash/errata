'use client';

import { useEffect, useState } from 'react';

const KEY = 'errata.tour.dismissed';

/** Add-on №4 (36 §4.7): one dismissible mono ribbon, on Ask only. */
export function TourRibbon() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(sessionStorage.getItem(KEY) !== '1');
  }, []);

  if (!show) return null;
  return (
    <div className="tour">
      <span>
        try: <b>what is my job title</b> → then <b>correct it</b> → then drag <b>time</b>
      </span>
      <button
        type="button"
        onClick={() => {
          sessionStorage.setItem(KEY, '1');
          setShow(false);
        }}
      >
        dismiss ✕
      </button>
    </div>
  );
}
