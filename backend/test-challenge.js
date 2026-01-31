const fetch = require('node-fetch');

async function testChallenge() {
  try {
    console.log('Testing challenge endpoint...');
    const response = await fetch('http://localhost:3333/v1/auth/challenge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        wallet: '11111111111111111111111111111112'
      })
    });

    console.log('Response status:', response.status);
    const result = await response.json();
    console.log('Response:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

testChallenge();
