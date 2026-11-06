(() => {
  let discounted = false;
  const coupon = () => discounted ? 'BLUE10' : '';
  const total = () => (Number(document.getElementById('quantity').value || 1) * 120 * (discounted ? 0.9 : 1)).toFixed(2);
  function drawTotal() { document.getElementById('total').textContent = `$${total()}`; document.getElementById('pay').textContent = `Pay $${total()}`; }
  function payload() { return new URLSearchParams({ size: document.getElementById('size').value, colour: document.querySelector('input[name=colour]:checked').value, quantity: document.getElementById('quantity').value, coupon: coupon(), total: total() }); }
  document.getElementById('quantity').addEventListener('input', drawTotal);
  document.getElementById('apply').addEventListener('click', () => {
    discounted = document.getElementById('coupon').value.trim().toUpperCase() === 'BLUE10';
    document.getElementById('coupon-status').textContent = discounted ? 'BLUE10 applied: 10% off.' : 'Coupon not recognised.';
    drawTotal();
  });
  document.getElementById('checkout').addEventListener('click', async () => {
    const response = await fetch('/api/shop/cart', { method: 'POST', body: payload() });
    if (!response.ok) { document.getElementById('error').textContent = 'Could not prepare checkout.'; return; }
    document.getElementById('product').hidden = true;
    document.getElementById('checkout-page').hidden = false;
    document.getElementById('review').textContent = [...payload().entries()].map(([key, val]) => `${key}: ${val}`).join('\n');
  });
  document.getElementById('pay').addEventListener('click', async () => {
    const response = await fetch('/api/shop/pay', { method: 'POST', body: payload() });
    const result = await response.json();
    document.getElementById('checkout-page').hidden = true;
    document.getElementById('done').hidden = false;
    document.getElementById('order').textContent = result.order;
  });
})();
