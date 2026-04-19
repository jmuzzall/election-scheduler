require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'election-scheduler-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Make session data available to all views
app.use((req, res, next) => {
  res.locals.admin = req.session.admin || null;
  res.locals.candidate = req.session.candidate || null;
  next();
});

// Routes (loaded after DB init)
app.get('/', (req, res) => {
  res.render('index');
});

app.use('/admin', require('./routes/admin'));
app.use('/candidate', require('./routes/candidate'));
app.use('/api', require('./routes/api'));

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found', status: 404 });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { message: 'Something went wrong', status: 500 });
});

// Initialize database then start server
db.initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`Election Scheduler running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
