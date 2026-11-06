// A small client-side shop: real DOM transitions, session cart, and one loopback payment event.
// Keep the content-script document alive while routes change, as a typical single-page shop does.
const routes = new Set(['/', '/cart.html', '/checkout.html', '/confirmed.html']);
async function navigate(path) {
  if (!routes.has(path)) throw new Error('Unknown fixture route');
  const response = await fetch(path);
  if (!response.ok) throw new Error('Fixture route unavailable');
  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  document.querySelector('main').replaceWith(next.querySelector('main'));
  document.title = next.title;
  history.pushState(null, '', path);
  bind();
}
function bind() {
  const add = document.querySelector('#add');
  if (add) add.onclick = async () => {
    sessionStorage.setItem('demo-cart', 'compass');
    await navigate('/cart.html');
  };
  const cart = document.querySelector('#cart');
  if (cart) {
    cart.innerHTML = sessionStorage.getItem('demo-cart') === 'compass'
      ? '<h2>Brass compass</h2><div class="row"><span>Quantity</span><strong>1</strong></div><div class="row"><span>Subtotal</span><strong>$119.00</strong></div><button id="review" type="button">Review order details</button>'
      : '<p>Your cart is empty.</p><a href="/">Visit the shop</a>';
    const review = document.querySelector('#review');
    if (review) review.onclick = () => navigate('/checkout.html');
  }
  const pay = document.querySelector('#pay');
  if (pay) {
    if (sessionStorage.getItem('demo-cart') !== 'compass') {
      pay.disabled = true;
      document.querySelector('#status').textContent = 'Your cart is empty.';
    }
    pay.onclick = async () => {
      pay.disabled = true;
      try {
        const response = await fetch('/__demo__/pay', { method: 'POST' });
        if (!response.ok) throw new Error('Fixture payment failed');
        sessionStorage.setItem('demo-confirmed', 'yes');
        sessionStorage.removeItem('demo-cart');
        await navigate('/confirmed.html');
      } catch {
        document.querySelector('#status').textContent = 'Fixture server unavailable.';
      }
    };
  }
  const result = document.querySelector('#result');
  if (result) result.innerHTML = sessionStorage.getItem('demo-confirmed') === 'yes'
    ? '<span class="ok">✓</span><h1>Order confirmed</h1><p>One brass compass. Ready for your next adventure.</p><section class="card"><div class="row"><span>Order</span><strong>FAKE-001</strong></div><div class="row total"><span>Total paid</span><strong>$142.80</strong></div></section><p class="notice">Local fixture only. No real payment was processed.</p>'
    : '<h1>No order yet</h1><a href="/">Visit the test shop</a>';
}
bind();
