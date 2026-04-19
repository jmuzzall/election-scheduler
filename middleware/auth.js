// Admin authentication middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  res.redirect('/admin/login');
}

// Candidate authentication middleware
function requireCandidate(req, res, next) {
  if (req.session && req.session.candidate) {
    return next();
  }
  res.redirect('/candidate/login');
}

module.exports = { requireAdmin, requireCandidate };
