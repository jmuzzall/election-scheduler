const CAMPUSES = ['McLean', 'Herndon'];

function normalizeCampus(value) {
  const match = CAMPUSES.find(c => c.toLowerCase() === String(value || '').trim().toLowerCase());
  return match || 'McLean';
}

function campusOf(row) {
  return normalizeCampus(row && row.campus);
}

module.exports = { CAMPUSES, normalizeCampus, campusOf };
