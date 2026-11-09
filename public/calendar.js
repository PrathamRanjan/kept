// Bryntum Calendar (trial build from npm via jsDelivr) showing renewals, pauses, resumes, discounts and payment follow-ups.
const BRYNTUM = "https://cdn.jsdelivr.net/npm/@bryntum/calendar-trial@7.3.8";
const el = document.getElementById("calendar");
if (el) {
  try {
    const [{ Calendar }, data] = await Promise.all([
      import(`${BRYNTUM}/calendar.module.js`),
      fetch(el.dataset.src, { credentials: "same-origin" }).then((r) => r.json()),
    ]);
    const calendar = new Calendar({
      appendTo: el,
      date: new Date(),
      mode: "month",
      readOnly: true,
      sidebar: { collapsed: true },
      resources: data.resources,
      events: data.events.map((e) => ({ ...e, name: e.sample ? `${e.name} (sample)` : e.name })),
      modes: { year: null, agenda: { title: "List" } },
      listeners: {
        eventClick({ eventRecord }) {
          if (eventRecord && eventRecord.subscriberRef) window.location.href = `/manage/${eventRecord.subscriberRef}`;
        },
      },
    });
    window.keptCalendar = calendar;
  } catch (e) {
    el.innerHTML = `<div class="empty">Calendar could not load (${String(e.message || e)}). The subscriber table below has the same dates.</div>`;
  }
}
