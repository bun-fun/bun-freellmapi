// Quick test: login then check /api/settings/unify returns overrides field

// Login first
const loginRes = await fetch('http://localhost:3001/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin', password: 'ef7f4bdb-29549e18-5a852d5d' }),
});

if (!loginRes.ok) {
  console.log('Login failed:', loginRes.status);
  const body = await loginRes.json();
  console.log(JSON.stringify(body));
  process.exit(1);
}

const loginData = await loginRes.json();
const token = loginData.token;
console.log('Login OK, token:', token ? token.slice(0, 16) + '...' : 'none');

// Fetch the unify endpoint
const res = await fetch('http://localhost:3001/api/settings/unify', {
  headers: { Authorization: `Bearer ${token}` },
});
const data = await res.json();
console.log('Status:', res.status);
console.log('Response:', JSON.stringify(data, null, 2));

// Verify overrides field exists
if (data.overrides && Array.isArray(data.overrides.merges) && Array.isArray(data.overrides.splits)) {
  console.log('\n✅ overrides field present with merges and splits arrays');
} else {
  console.log('\n❌ overrides field missing or malformed');
}
