import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'

if (import.meta.env.MODE === "production") {
    const analyticsUrl = import.meta.env.VITE_ANALYTICS_URL;
    const websiteId = import.meta.env.VITE_WEBSITE_ID;

    if (analyticsUrl && websiteId) {
        const script = document.createElement("script");
        script.src = analyticsUrl;
        script.defer = true;
        script.setAttribute("data-website-id", websiteId);
        document.head.appendChild(script);
    }
}


const app = createApp(App)

app.use(createPinia())

app.mount('#app')
