/**
 * Candidate Portal – Calendar Popup & Blackout Date Management
 */

let selectedDates = [];
let calendarInstance = null;
let calendarModal = null;

function initCandidatePortal(config) {
  const { startDate, endDate, deadline, blackoutDates, isLocked } = config;

  // Initialize selected dates from server
  selectedDates = [...blackoutDates];

  // Compute which dates are Sundays in the range (only selectable dates)
  const sundaysInRange = getSundaysInRange(startDate, endDate);

  // Initialize the Bootstrap modal
  const modalEl = document.getElementById('calendarModal');
  if (modalEl) {
    calendarModal = new bootstrap.Modal(modalEl);

    // Initialize Flatpickr inside the modal only once it's shown
    // (so the calendar renders at the correct size)
    let calendarInitialized = false;

    modalEl.addEventListener('shown.bs.modal', function () {
      if (!calendarInitialized) {
        calendarInstance = flatpickr('#calendar-container', {
          inline: true,
          mode: 'multiple',
          dateFormat: 'Y-m-d',
          minDate: startDate,
          maxDate: endDate,
          defaultDate: selectedDates,
          enable: sundaysInRange,
          onChange: function (dates) {
            selectedDates = dates.map(d => formatDate(d));
            updatePopupCount();
            updateSummary();
          }
        });
        calendarInitialized = true;
      }
    });
  }

  // Wire up the "Open Calendar" button
  const btnOpen = document.getElementById('btnOpenCalendar');
  if (btnOpen && !isLocked) {
    btnOpen.addEventListener('click', function () {
      if (calendarModal) calendarModal.show();
    });
  }

  // Update displays
  updateSummary();
  updatePopupCount();

  // Start countdown timer
  if (deadline && !isLocked) {
    updateCountdown(deadline);
    setInterval(() => updateCountdown(deadline), 1000);
  }
}

function getSundaysInRange(startDate, endDate) {
  const sundays = [];
  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  // Advance to first Sunday
  while (current.getDay() !== 0 && current <= end) {
    current.setDate(current.getDate() + 1);
  }

  while (current <= end) {
    sundays.push(formatDate(current));
    current.setDate(current.getDate() + 7);
  }

  return sundays;
}

function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function updatePopupCount() {
  const el = document.getElementById('popupSelectionCount');
  if (!el) return;
  const n = selectedDates.length;
  el.textContent = n + ' Sunday' + (n !== 1 ? 's' : '') + ' marked unavailable';
}

function updateSummary() {
  const container = document.getElementById('selectedSummary');
  if (!container) return;

  if (selectedDates.length === 0) {
    container.innerHTML = '<p class="text-success mb-0"><i class="bi bi-check-circle"></i> You are available for all Sundays.</p>';
    return;
  }

  const sorted = [...selectedDates].sort();
  let html = '<ul class="list-unstyled mb-0">';
  for (const date of sorted) {
    const d = new Date(date + 'T00:00:00');
    const formatted = d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    html += '<li class="mb-1"><i class="bi bi-x-circle text-danger"></i> ' + formatted + '</li>';
  }
  html += '</ul>';
  container.innerHTML = html;
}

function updateCountdown(deadline) {
  const el = document.getElementById('countdown');
  if (!el) return;

  const now = new Date();
  const end = new Date(deadline);
  const diff = end - now;

  if (diff <= 0) {
    el.textContent = 'Deadline passed';
    el.style.color = '#e74c3c';
    setTimeout(() => location.reload(), 2000);
    return;
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  const parts = [];
  if (days > 0) parts.push(days + ' day' + (days !== 1 ? 's' : ''));
  if (hours > 0) parts.push(hours + ' hr' + (hours !== 1 ? 's' : ''));
  if (minutes > 0) parts.push(minutes + ' min');
  if (days === 0) parts.push(seconds + ' sec');

  el.textContent = parts.join(', ');
}

async function saveBlackouts() {
  const btn = document.getElementById('btnSave');
  const result = document.getElementById('saveResult');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';

  try {
    const resp = await fetch('/candidate/save-blackouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates: selectedDates })
    });

    const data = await resp.json();
    if (data.success) {
      result.innerHTML = '<div class="alert alert-success"><i class="bi bi-check-circle"></i> ' + data.message + '</div>';
    } else {
      result.innerHTML = '<div class="alert alert-danger"><i class="bi bi-exclamation-triangle"></i> ' + (data.error || 'Failed to save.') + '</div>';
    }
  } catch (err) {
    result.innerHTML = '<div class="alert alert-danger"><i class="bi bi-exclamation-triangle"></i> Network error. Please try again.</div>';
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-check-lg"></i> Save Availability';

  setTimeout(() => {
    if (result.querySelector('.alert-success')) {
      result.innerHTML = '';
    }
  }, 5000);
}
