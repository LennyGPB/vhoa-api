// Prépare Stripe pour VHOA Premium. Sans danger à relancer : ce qui existe déjà est réutilisé.
//
//   npm run stripe:setup -- --api https://api.vhoa.fr --web https://vhoa.fr
//
// Crée (une seule fois) :
//  - le produit « VHOA Premium » et ses deux prix : 4,99 €/mois et 35 €/an (TTC) ;
//  - le coupon de lancement VHOA_LANCEMENT : 10 € de remise sur la 1re année, 100 utilisations ;
//  - un portail client propre à VHOA (moyen de paiement, factures, résiliation en fin de période) ;
//  - le webhook vers l'API (son secret whsec_… est affiché UNE seule fois : le mettre dans
//    STRIPE_WEBHOOK_SECRET).
// Rien de ce qui existe déjà sur le compte (autres activités) n'est modifié.
import Stripe from 'stripe';

try {
  process.loadEnvFile();
} catch {
  /* variables fournies par l'environnement */
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]?.replace(/\/+$/, '') : undefined;
};
const api = arg('api');
const web = arg('web') ?? process.env.WEB_URL?.replace(/\/+$/, '');
const key = process.env.STRIPE_SECRET_KEY;
if (!key || !web) {
  console.error('Il faut STRIPE_SECRET_KEY et --web <adresse du site> (ou WEB_URL).');
  process.exit(1);
}

const stripe = new Stripe(key);
const META = { app: 'vhoa' };

// 1. Produit : d'abord celui des prix existants (lecture immédiate), puis la recherche
// (son index met quelques secondes à voir un produit tout juste créé : risque de doublon).
const known = await stripe.prices.list({ lookup_keys: ['vhoa_premium_monthly', 'vhoa_premium_yearly'], expand: ['data.product'] });
const products = known.data.length
  ? { data: [known.data[0].product] }
  : await stripe.products.search({ query: "metadata['app']:'vhoa' AND active:'true'" });
const product =
  products.data[0] ??
  (await stripe.products.create({
    name: 'VHOA Premium',
    description: 'Coach IA (60 analyses par mois, retour détaillé, progression), gels de série et effets de profil.',
    metadata: META,
  }));
console.log(`Produit       ${product.id}`);

// 2. Prix (retrouvés par leur lookup_key)
const PRICES = [
  { lookup_key: 'vhoa_premium_monthly', unit_amount: 499, interval: 'month', nickname: 'Premium mensuel' },
  { lookup_key: 'vhoa_premium_yearly', unit_amount: 3500, interval: 'year', nickname: 'Premium annuel' },
];
const existing = await stripe.prices.list({ lookup_keys: PRICES.map((p) => p.lookup_key), active: true });
for (const p of PRICES) {
  let price = existing.data.find((x) => x.lookup_key === p.lookup_key);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      currency: 'eur',
      unit_amount: p.unit_amount,
      recurring: { interval: p.interval },
      lookup_key: p.lookup_key,
      nickname: p.nickname,
      tax_behavior: 'inclusive',
      metadata: META,
    });
  }
  console.log(`Prix          ${price.id}  ${p.lookup_key}  ${(price.unit_amount / 100).toFixed(2)} €`);
}

// 3. Coupon de lancement
let coupon;
try {
  coupon = await stripe.coupons.retrieve('VHOA_LANCEMENT');
} catch {
  coupon = await stripe.coupons.create({
    id: 'VHOA_LANCEMENT',
    name: 'Offre de lancement VHOA',
    amount_off: 1000,
    currency: 'eur',
    duration: 'once',
    max_redemptions: 100,
    applies_to: { products: [product.id] },
    metadata: META,
  });
}
console.log(`Coupon        ${coupon.id}  ${coupon.times_redeemed}/${coupon.max_redemptions} utilisés`);

// 4. Portail client propre à VHOA (le portail par défaut du compte n'est pas touché)
const portals = await stripe.billingPortal.configurations.list({ limit: 100 });
let portal = portals.data.find((c) => c.metadata?.app === 'vhoa' && c.active);
if (!portal) {
  portal = await stripe.billingPortal.configurations.create({
    name: 'VHOA',
    business_profile: {
      headline: 'VHOA Premium',
      privacy_policy_url: `${web}/confidentialite`,
      terms_of_service_url: `${web}/cgv`,
    },
    default_return_url: `${web}/profil/abonnement`,
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name'] },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        // Motif demandé (facultatif pour le client) : utile pour comprendre les départs.
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'unused', 'too_complex', 'low_quality', 'other'],
        },
      },
    },
    metadata: META,
  });
}
console.log(`Portail       ${portal.id}   → STRIPE_PORTAL_CONFIG`);

// 5. Webhook vers l'API
if (api) {
  const url = `${api}/v1/webhooks/stripe`;
  const hooks = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = hooks.data.find((h) => h.url === url);
  if (found) {
    console.log(`Webhook       ${found.id}  déjà créé (secret visible dans le tableau de bord Stripe)`);
  } else {
    const hook = await stripe.webhookEndpoints.create({
      url,
      description: 'VHOA Premium',
      enabled_events: [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
      ],
      metadata: META,
    });
    console.log(`Webhook       ${hook.id}`);
    console.log(`STRIPE_WEBHOOK_SECRET=${hook.secret}   ← à copier maintenant, il ne sera plus affiché`);
  }
} else {
  console.log('Webhook       (ajoute --api <adresse de l’API> une fois l’API en ligne)');
}
