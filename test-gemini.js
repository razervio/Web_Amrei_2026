require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
    console.log('API KEY:', process.env.GEMINI_API_KEY ? 'TERBACA' : 'TIDAK TERBACA');
    console.log('MODEL:', process.env.GEMINI_MODEL);

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        const model = genAI.getGenerativeModel({
            model: process.env.GEMINI_MODEL
        });

        const result = await model.generateContent('Halo, jawab singkat: apakah kamu aktif?');

        console.log('✅ GEMINI BERHASIL:');
        console.log(result.response.text());

    } catch (error) {
        console.log('❌ GEMINI ERROR:');
        console.log(error.message);
    }
}

test();