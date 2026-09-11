function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function obterSessaoPush() {
  if (typeof supabaseClient === 'undefined') return null;
  const { data } = await supabaseClient.auth.getSession();
  return data && data.session ? data.session : null;
}

async function registrarPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return false;
    }
    if (typeof VAPID_PUBLIC_KEY === 'undefined' || !VAPID_PUBLIC_KEY) return false;

    const session = await obterSessaoPush();
    if (!session) return false;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    const response = await fetch(FUNCTIONS_URL + '/push-subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': SB_KEY
      },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        userAgent: navigator.userAgent
      })
    });
    return response.ok;
  } catch (err) {
    console.warn('Push não ativado:', err);
    return false;
  }
}

async function enviarPush(payload) {
  try {
    const session = await obterSessaoPush();
    if (!session) return false;
    const response = await fetch(FUNCTIONS_URL + '/send-push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': SB_KEY
      },
      body: JSON.stringify(payload || {})
    });
    return response.ok;
  } catch (err) {
    console.warn('Falha ao enviar push:', err);
    return false;
  }
}
