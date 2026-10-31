// A panel popped out of daw-better into its own window (see windows.js). The main page moves
// the panel in here and runs it from there; this page only finds the main page again after
// either of them reloads, and closes itself once the main page is gone.

const GIVE_UP = 10_000; // ms to wait for the main page to come back from a reload
const note = document.querySelector('.popout-note');
const popped = !!opener; // opened by daw-better, not typed in or restored by the browser
let host = null;
let lostAt = Date.now();

function check() {
  if (!popped) {
    note.textContent = 'This window shows a panel of daw-better. Open daw-better and press ↗ on a panel to pop it out.';
    return;
  }
  // Once the main page's tab is closed, opener reads null.
  if (!opener || opener.closed) return close();
  let found = null;
  try {
    found = opener.dawBetter ?? null;
  } catch {
    // The main page went to another site.
  }
  if (found && found !== host) {
    try {
      found.adopt(window);
      host = found;
    } catch (err) {
      console.warn('daw-better could not take this window back', err);
    }
  } else if (!found) {
    // The main page is reloading: the panel in here stopped working with the old page.
    if (host) {
      host = null;
      lostAt = Date.now();
      note.textContent = 'Waiting for daw-better…';
      document.body.replaceChildren(note);
    }
    if (Date.now() - lostAt > GIVE_UP) close();
  }
}

check();
setInterval(check, 300);
