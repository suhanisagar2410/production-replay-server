import express from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

async function createSession(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 day session
  await prisma.session.create({
    data: { userId, token: sessionToken, expiresAt },
  });
  return sessionToken;
}

// ================= EMAIL / PASSWORD AUTH =================

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists. Please login or use social login.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name }
    });

    const token = await createSession(user.id);
    res.json({ token, user });
  } catch (err) {
    console.error('Register Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!user.password) {
      return res.status(401).json({ error: 'This account uses social login (Google/GitHub).' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = await createSession(user.id);
    res.json({ token, user });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================= GITHUB OAUTH =================

router.get('/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) return res.status(500).send('GitHub Client ID not configured.');
  const redirectUri = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=read:user,user:email`;
  res.redirect(redirectUri);
});

router.get('/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');

  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }),
    });

    const tokenData = await tokenResponse.json() as any;
    if (tokenData.error) return res.redirect(`${FRONTEND_URL}/?error=github_auth_failed`);

    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    
    const githubUser = await userResponse.json() as any;
    if (!githubUser || !githubUser.id) return res.redirect(`${FRONTEND_URL}/?error=github_user_fetch_failed`);

    // Smart Account Linking
    let user = null;
    if (githubUser.email) {
      user = await prisma.user.findUnique({ where: { email: githubUser.email } });
    }

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          githubId: String(githubUser.id),
          avatarUrl: user.avatarUrl || githubUser.avatar_url,
          name: user.name || githubUser.name || githubUser.login,
        }
      });
    } else {
      user = await prisma.user.upsert({
        where: { githubId: String(githubUser.id) },
        update: {
          name: githubUser.name || githubUser.login,
          email: githubUser.email,
          avatarUrl: githubUser.avatar_url,
        },
        create: {
          githubId: String(githubUser.id),
          name: githubUser.name || githubUser.login,
          email: githubUser.email,
          avatarUrl: githubUser.avatar_url,
        },
      });
    }

    const sessionToken = await createSession(user.id);
    res.redirect(`${FRONTEND_URL}/?session_token=${sessionToken}`);
  } catch (error) {
    console.error('GitHub Callback Error:', error);
    res.redirect(`${FRONTEND_URL}/?error=internal_auth_error`);
  }
});

// ================= GOOGLE OAUTH =================

router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).send('Google Client ID not configured.');
  const redirectUri = encodeURIComponent(`${BACKEND_URL}/auth/google/callback`);
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=email profile`;
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');

  try {
    const redirectUri = `${BACKEND_URL}/auth/google/callback`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json() as any;
    if (tokenData.error) return res.redirect(`${FRONTEND_URL}/?error=google_auth_failed`);

    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    
    const googleUser = await userResponse.json() as any;
    if (!googleUser || !googleUser.id) return res.redirect(`${FRONTEND_URL}/?error=google_user_fetch_failed`);

    // Smart Account Linking
    let user = null;
    if (googleUser.email) {
      user = await prisma.user.findUnique({ where: { email: googleUser.email } });
    }

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: String(googleUser.id),
          avatarUrl: user.avatarUrl || googleUser.picture,
          name: user.name || googleUser.name,
        }
      });
    } else {
      user = await prisma.user.upsert({
        where: { googleId: String(googleUser.id) },
        update: {
          name: googleUser.name,
          email: googleUser.email,
          avatarUrl: googleUser.picture,
        },
        create: {
          googleId: String(googleUser.id),
          name: googleUser.name,
          email: googleUser.email,
          avatarUrl: googleUser.picture,
        },
      });
    }

    const sessionToken = await createSession(user.id);
    res.redirect(`${FRONTEND_URL}/?session_token=${sessionToken}`);
  } catch (error) {
    console.error('Google Callback Error:', error);
    res.redirect(`${FRONTEND_URL}/?error=internal_auth_error`);
  }
});

// ================= SESSION MGMT =================

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/logout', requireAuth, async (req, res) => {
  const authHeader = req.headers.authorization!;
  const token = authHeader.replace('Bearer ', '');
  await prisma.session.deleteMany({ where: { token } });
  res.json({ success: true });
});

export default router;
