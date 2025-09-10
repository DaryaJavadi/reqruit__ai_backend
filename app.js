// server.js - FIXED VERSION WITH DEBUGGING
require('dotenv').config();

const express = require('express');
const { IntelligentCandidateMatcher } = require('./candidate-matcher');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET","POST","DELETE"],
    credentials: true
}));
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { spawn } = require('child_process');
const CVExcelExporter = require('./excel_exporter');
// Sentence embedding model (Node.js alternative to SentenceTransformer)
let transformers;
let embeddingPipeline; // lazy-initialized
// PDF annotations extractor
let pdfjsLib;
try {
    pdfjsLib = require('pdfjs-dist');
    // Configure worker to use node build
    if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
        // In Node, workerSrc is not required, but keep for compatibility
        pdfjsLib.GlobalWorkerOptions.workerSrc = require('pdfjs-dist/build/pdf.worker.js');
    }
} catch (e) {
    console.warn('⚠️ pdfjs-dist not installed; PDF link annotations will not be extracted.');
}
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Configure your Gemini API key from environment variable
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY environment variable is required');
    console.error('Please create a .env file with your Gemini API key:');
    console.error('GEMINI_API_KEY=your_api_key_here');
    process.exit(1);
}

// Simple AI scoring with a lean prompt using only free-text requirements and a concise candidate summary
function createSimpleAIScoringPrompt(requirementsText, candidateSummary) {
    return `You are an expert technical recruiter. Evaluate the candidate against the job requirements and produce a strict 0-100 score.

JOB REQUIREMENTS:
"""
${requirementsText}
"""

CANDIDATE SUMMARY:
"""
${candidateSummary}
"""

Rules:
- Be strict and use the full 0–100 range.
- Score reflects overall suitability (skills, seniority, domain alignment, recency).
- Penalize missing must-haves hard.

Respond ONLY in JSON:
{
  "score": number,
  "rationale": "short reason",
  "matched_skills": ["skill1", "skill2"]
}`.trim();
}

async function scoreCandidateWithAISimple(cv, requirementsText) {
    const summary = buildCandidateSummary(cv);
    const prompt = createSimpleAIScoringPrompt(requirementsText, summary);
    const raw = await withTimeout(callGeminiAPI(prompt), 25000, 'ai_scoring_simple');
    let text = (raw || '').trim();
    if (text.startsWith('```json')) text = text.slice(7);
    if (text.startsWith('```')) text = text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, -3);
    text = text.trim();
    try {
        const parsed = JSON.parse(text);
        return {
            score: typeof parsed.score === 'number' ? parsed.score : 0,
            rationale: parsed.rationale || parsed.reason || '',
            matched_skills: Array.isArray(parsed.matched_skills) ? parsed.matched_skills : [],
            raw: parsed
        };
    } catch (e) {
        console.error('❌ AI simple scoring JSON parse error:', e.message);
        console.error('Raw AI response:', text.substring(0, 500));
        throw new Error('Invalid AI response');
    }
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// **NEW: Enhanced AI Matching Analysis Function with Human-like Reasoning**
async function analyzeMatch(candidate, requirements) {
    const prompt = `
Your job is to evaluate how suitable each candidate is for a given role. 
Do not just match keywords — use reasoning about skill similarity, job title equivalence, and transferable experience.

JOB REQUIREMENTS:
${requirements}

CANDIDATE PROFILE:
Name: ${candidate.name || 'N/A'}
Professional Specialty: ${candidate.professional_specialty || 'N/A'}
Years of Experience: ${candidate.total_years_experience || 0}
Summary: ${candidate.summary || 'N/A'}

Skills:
- Technical: ${JSON.stringify(candidate.skills?.technical_skills || [])}
- Programming: ${JSON.stringify(candidate.skills?.programming_languages || [])}
- Frameworks/Tools: ${JSON.stringify(candidate.skills?.frameworks_tools || [])}
- Soft Skills: ${JSON.stringify(candidate.skills?.soft_skills || [])}
- Languages: ${JSON.stringify(candidate.skills?.languages || [])}
- Certifications: ${JSON.stringify(candidate.skills?.certifications || [])}

Experience:
${JSON.stringify(candidate.experience || [])}

Education:
${JSON.stringify(candidate.education || [])}

Projects:
${JSON.stringify(candidate.projects || [])}

Your task:
- For this candidate, analyze suitability in a human-like way:
  * Consider synonyms and related technologies (e.g., "TensorFlow" counts as deep learning skills).
  * Treat equivalent or closely related job titles as valid (e.g., "Data Scientist" ≈ "Machine Learning Engineer" ≈ "AI Specialist").
  * If the main specialization of a candidate matches the required role domain, count them as suitable even if the exact job title is slightly different.
  * Give partial credit for transferable skills (e.g., "C++ OOP" when the requirement is "Java").
  * Weigh years of experience, education relevance, and career progression.
  * Treat must-have requirements as critical: missing them lowers the score heavily.
  * Nice-to-have requirements boost the score but are not mandatory.

SCORING GUIDELINES (0-100):
1. **Direct Specialty Match (80-95%)**: If candidate's main specialty directly matches the required role (e.g., Data Scientist for Data Scientist role), start with 80-85% base score
2. **Related Specialty Match (70-85%)**: If candidate's specialty is closely related (e.g., ML Engineer for Data Scientist), start with 70-80% base score
3. **Transferable Specialty (60-75%)**: If candidate has transferable skills but different domain, start with 60-70% base score
4. **Poor Match (0-50%)**: If candidate lacks core domain knowledge or critical skills

ADJUSTMENT FACTORS:
- **Must-have skills present**: +5-10% per critical skill
- **Must-have skills missing**: -15-25% per missing critical skill
- **Nice-to-have skills**: +2-5% per additional skill
- **Experience level match**: +/-5-10% based on seniority alignment
- **Education relevance**: +/-3-7% based on degree alignment
- **Recent experience**: +3-8% if skills used in current/recent roles

IMPORTANT: Be generous with scoring when there's a clear domain match. A Data Scientist with relevant skills should score 80-90%, not 70-75%.

Return ONLY a JSON object with this structure:
{
    "percentage": 85,
    "reasoning": "Strong domain match - candidate's Machine Learning Engineer background aligns well with Data Scientist role. TensorFlow and PyTorch experience covers deep learning requirements. 5+ years experience meets seniority needs. Missing SQL (must-have) significantly impacts score, but strong Python and ML fundamentals show transferable skills. Overall good fit with some gaps.",
    "matchedSkills": ["Python", "Machine Learning", "TensorFlow", "Data Analysis", "Statistics"],
    "missingCritical": ["SQL", "Database Management"],
    "transferableSkills": ["C++ to Java", "PyTorch to TensorFlow", "Research to Business Analytics"]
}

Important: Return only valid JSON, no additional text. Use human-like reasoning that considers skill relationships and role equivalencies.
    `;

    try {
        const response = await callGeminiAPI(prompt);
        
        // Clean response text
        let responseText = response.trim();
        if (responseText.startsWith('```json')) {
            responseText = responseText.substring(7);
        }
        if (responseText.startsWith('```')) {
            responseText = responseText.substring(3);
        }
        if (responseText.endsWith('```')) {
            responseText = responseText.slice(0, -3);
        }
        
        const analysis = JSON.parse(responseText.trim());
        
        // Validate and sanitize the response
        return {
            percentage: Math.min(100, Math.max(0, parseInt(analysis.percentage) || 0)),
            reasoning: analysis.reasoning || 'Analysis completed successfully',
            matchedSkills: Array.isArray(analysis.matchedSkills) ? analysis.matchedSkills : [],
            missingCritical: Array.isArray(analysis.missingCritical) ? analysis.missingCritical : [],
            transferableSkills: Array.isArray(analysis.transferableSkills) ? analysis.transferableSkills : []
        };
        
    } catch (error) {
        console.error('Error in analyzeMatch:', error);
        
        // Fallback to simple keyword matching if AI fails
        return performSimpleKeywordMatching(candidate, requirements);
    }
}

// **NEW: Fallback Simple Matching Function**
function performSimpleKeywordMatching(candidate, requirements) {
    try {
        const reqWords = requirements.toLowerCase()
            .split(/\W+/)
            .filter(word => word.length > 2)
            .filter(word => !['the', 'and', 'or', 'but', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'will', 'have', 'has', 'had'].includes(word));
        
        // Full text match
        const candidateText = JSON.stringify(candidate).toLowerCase();
        const matchedWords = reqWords.filter(word => candidateText.includes(word));

        // Specialty-focused match (extra weight)
        const specialty = (candidate.professional_specialty || '').toLowerCase();
        const specialtyMatches = reqWords.filter(word => specialty.includes(word));

        // Base score from overall keyword match
        let score = matchedWords.length / Math.max(1, reqWords.length);

        // Add weighted boost for specialty matches
        // Each specialty match adds a small bonus up to a cap
        const specialtyBoost = Math.min(0.2, specialtyMatches.length * 0.05); // max +20%
        score = Math.min(1, score + specialtyBoost);

        const percentage = Math.round(score * 100);
        
        // Compose reasoning
        const baseReason = `Keyword analysis found ${matchedWords.length} of ${reqWords.length} relevant terms in candidate profile.`;
        const specReason = specialtyMatches.length > 0
            ? ` Specialty match boost: ${specialtyMatches.length} term(s) matched in professional_specialty."${candidate.professional_specialty || ''}"`
            : '';
        
        // Merge and dedupe matched terms, showing specialty hits first
        const mergedMatches = Array.from(new Set([ ...specialtyMatches, ...matchedWords ])).slice(0, 10);

        return {
            percentage: Math.min(percentage, 85), // Cap fallback matching at 85%
            reasoning: `${baseReason}${specReason}`.trim(),
            matchedSkills: mergedMatches
        };
    } catch (error) {
        console.error('Fallback matching error:', error);
        return {
            percentage: 0,
            reasoning: 'Unable to analyze candidate match due to technical issues',
            matchedSkills: []
        };
    }
}

// ===== Gemini API usage limiter (daily + per-minute) =====
const MODEL_NAME = 'gemini-1.5-flash';
const DAILY_LIMIT = 1500;
const MINUTE_LIMIT = 15;

let requestsToday = 0;
let requestsThisMinute = 0;

function getPacificTime() {
    const nowUTC = new Date();
    const utcMillis = nowUTC.getTime() + nowUTC.getTimezoneOffset() * 60000;
    const pacificOffsetHours = -8; // PT standard (simple approach)
    return new Date(utcMillis + pacificOffsetHours * 3600000);
}

function resetDailyIfNeeded() {
    const pacTime = getPacificTime();
    if (pacTime.getHours() === 0 && pacTime.getMinutes() === 0) {
        requestsToday = 0;
        console.log('\n🔄 Daily Gemini quota counters reset.');
    }
}

// Helper: timeout wrapper for async operations (used by AI scoring)
async function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
        const result = await Promise.race([promise, timeout]);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

function resetMinuteCounter() {
    requestsThisMinute = 0;
}

// Reset minute counter every 60 sec
setInterval(resetMinuteCounter, 60 * 1000);

// Rate limiting - more generous for development
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Increased limit
    message: { error: 'Too many requests, please try again later' }
});

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true
}));
app.use(express.json({ limit: '100mb' })); // Increased limit
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
// app.use(express.static('public'));
app.use(express.static(path.join(__dirname, "public")));

app.use('/api/', limiter);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// ================= Embedding utilities (SentenceTransformer-like) =================
async function getEmbeddingPipeline() {
    if (!embeddingPipeline) {
        try {
            if (!transformers) {
                transformers = require('@xenova/transformers');
            }
            const { pipeline } = transformers;
            embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
            console.log('🧠 Embedding model loaded: Xenova/all-MiniLM-L6-v2');
        } catch (e) {
            console.error('❌ Failed to load embedding model:', e.message);
            throw e;
        }
    }
    return embeddingPipeline;
}

function cvToText(cv) {
    try {
        const lines = [];
        const pushLine = (label, value) => {
            if (!value) return;
            if (Array.isArray(value)) {
                const flat = value.filter(Boolean).join(', ');
                if (flat) lines.push(`${label}: ${flat}`);
            } else if (typeof value === 'object') {
                const flat = JSON.stringify(value, null, 0).replace(/[\[\]{},:"]+/g, ' ').replace(/\s+/g, ' ').trim();
                if (flat) lines.push(`${label}: ${flat}`);
            } else {
                const s = String(value).trim();
                if (s) lines.push(`${label}: ${s}`);
            }
        };

        // Headline
        pushLine('Name', cv.name);
        pushLine('Professional Specialty', cv.professional_specialty);
        pushLine('Summary', cv.summary || cv.professional_summary);

        // Skills (grouped)
        const skills = cv.skills || {};
        pushLine('Technical Skills', skills.technical_skills);
        pushLine('Programming Languages', skills.programming_languages);
        pushLine('Frameworks and Tools', skills.frameworks_tools);
        pushLine('Soft Skills', skills.soft_skills);
        pushLine('Languages', skills.languages);
        pushLine('Certifications', skills.certifications);

        // Experience - flatten key fields in readable order
        if (Array.isArray(cv.experience)) {
            cv.experience.forEach((e, idx) => {
                const parts = [e.position, e.company, e.period || `${e.start_date || e.start || ''} - ${e.end_date || e.end || ''}`]
                    .filter(Boolean).join(' | ');
                pushLine(`Experience ${idx + 1}`, parts);
                if (e.description) pushLine(`Experience ${idx + 1} Description`, e.description);
                if (Array.isArray(e.responsibilities) && e.responsibilities.length) {
                    pushLine(`Experience ${idx + 1} Responsibilities`, e.responsibilities.join('; '));
                }
                if (Array.isArray(e.achievements) && e.achievements.length) {
                    pushLine(`Experience ${idx + 1} Achievements`, e.achievements.join('; '));
                }
            });
        } else {
            pushLine('Experience', cv.experience);
        }

        // Education
        if (Array.isArray(cv.education)) {
            cv.education.forEach((ed, idx) => {
                const parts = [ed.degree || ed.qualification, ed.field_of_study, ed.institution || ed.university,
                    (ed.start_date || ed.start || '') + ' - ' + (ed.end_date || ed.end || ed.graduation_date || '')]
                    .filter(Boolean).join(' | ');
                pushLine(`Education ${idx + 1}`, parts);
                if (ed.gpa) pushLine(`Education ${idx + 1} GPA`, ed.gpa);
                if (ed.honors && ed.honors.length) pushLine(`Education ${idx + 1} Honors`, ed.honors.join(', '));
                if (ed.relevant_courses && ed.relevant_courses.length) pushLine(`Education ${idx + 1} Courses`, ed.relevant_courses.join(', '));
            });
        } else {
            pushLine('Education', cv.education);
        }

        // Projects & Awards & Volunteering
        if (Array.isArray(cv.projects)) {
            cv.projects.forEach((p, idx) => {
                const parts = [p.name, Array.isArray(p.technologies) ? p.technologies.join(', ') : p.technologies, p.description]
                    .filter(Boolean).join(' | ');
                pushLine(`Project ${idx + 1}`, parts);
            });
        } else {
            pushLine('Projects', cv.projects);
        }
        pushLine('Awards', cv.awards);
        pushLine('Volunteer Work', cv.volunteer_work);

        const text = lines.filter(Boolean).join('\n');
        return text.length ? text : (cv.name || '');
    } catch (_) {
        return cv?.summary || '';
    }
}

async function embedText(text) {
    const pipe = await getEmbeddingPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    // output.data is a typed array
    return Array.from(output.data);
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return Math.max(0, Math.min(1, dot)); // clamp to [0,1]
}

// Ensure uploads directory exists before using multer (configurable via env)
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
        console.log(`📁 Created uploads directory at ${uploadsDir}`);
    }
    console.log(`📁 Uploads directory ready at ${uploadsDir}`);
} catch (e) {
    console.error('❌ Failed to prepare uploads directory:', e);
    process.exit(1);
}

// Configure multer for file uploads with validation
const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        console.log(`📁 Saving file to: ${uploadsDir}`);
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const filename = file.fieldname + '-' + Date.now() + path.extname(file.originalname);
        console.log(`📝 Generated filename: ${filename}`);
        cb(null, filename);
    }
});

const upload = multer({
    storage: multerStorage,
    limits: {
        fileSize: 20 * 1024 * 1024 // Increased to 20MB
    },
    fileFilter: (req, file, cb) => {
        console.log(`🔍 Checking file: ${file.originalname}, MIME: ${file.mimetype}`);
        
        const allowedTypes = ['.pdf', '.docx', '.txt'];
        const allowedMimes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain'
        ];
        
        const fileExtension = path.extname(file.originalname).toLowerCase();
        
        if (allowedTypes.includes(fileExtension) || allowedMimes.includes(file.mimetype)) {
            console.log(`✅ File accepted: ${file.originalname}`);
            cb(null, true);
        } else {
            console.log(`❌ File rejected: ${file.originalname} (${file.mimetype})`);
            cb(new Error(`Invalid file type. Only PDF, DOCX, and TXT files are allowed. Received: ${file.mimetype}`));
        }
    }
});

// Initialize SQLite database (configurable via env)
const dataDir = path.join('/opt/render/data', 'cv_parser_pro');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'cvs.db');

const repoDbPath = path.join(__dirname, 'cvs.db');
if (fs.existsSync(repoDbPath) && !fs.existsSync(dbPath)) {
    fs.copyFileSync(repoDbPath, dbPath);
}

console.log(`📊 Database path: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        process.exit(1);
    }
    console.log('📊 Connected to SQLite database at', dbPath);
});

// Create tables with enhanced structure
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS cvs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        name TEXT,
        email TEXT,
        phone TEXT,
        address TEXT,
        linkedin TEXT,
        github TEXT,
        website TEXT,
        professional_specialty TEXT,
        primary_experience_years REAL,
        secondary_experience_fields TEXT,
        total_years_experience REAL,
        highest_university_degree TEXT,
        university_name TEXT,
        courses_completed TEXT,
        summary TEXT,
        experience_data TEXT,
        education_data TEXT,
        skills_data TEXT,
        projects_data TEXT,
        awards_data TEXT,
        volunteer_work_data TEXT,
        metadata_data TEXT,
        original_language TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Error creating table:', err);
        } else {
            console.log('✅ CVs table ready');
        }
    });
});

// Language detection function with Azerbaijani support
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return 'English';
    
    const languagePatterns = {
        'Spanish': ['años', 'experiencia', 'educación', 'universidad', 'trabajo', 'empresa'],
        'French': ['années', 'expérience', 'éducation', 'université', 'travail', 'entreprise'],
        'German': ['jahre', 'erfahrung', 'bildung', 'universität', 'arbeit', 'unternehmen'],
        'Italian': ['anni', 'esperienza', 'educazione', 'università', 'lavoro', 'azienda'],
        'Portuguese': ['anos', 'experiência', 'educação', 'universidade', 'trabalho', 'empresa'],
        'Russian': ['лет', 'опыт', 'образование', 'университет', 'работа', 'компания'],
        'Arabic': ['سنوات', 'خبرة', 'تعليم', 'جامعة', 'عمل', 'شركة'],
        'Turkish': ['yıl', 'deneyim', 'eğitim', 'üniversite', 'iş', 'şirket'],
        'Chinese': ['年', '经验', '教育', '大学', '工作', '公司'],
        'Azerbaijani': ['il', 'təcrübə', 'təhsil', 'universitet', 'iş', 'şirkət', 'bakı', 'azərbaycan']
    };
    
    const textLower = text.toLowerCase();
    let maxMatches = 0;
    let detectedLanguage = 'English';
    
    Object.entries(languagePatterns).forEach(([language, keywords]) => {
        const matches = keywords.filter(keyword => textLower.includes(keyword)).length;
        if (matches > maxMatches) {
            maxMatches = matches;
            detectedLanguage = language;
        }
    });
    
    console.log(`🌍 Language detection: ${detectedLanguage} (${maxMatches} matches)`);
    return detectedLanguage;
}

// Enhanced prompts
function createMainParsingPrompt(cvText) {
    const detectedLang = detectLanguage(cvText);
    
    return `
You are an expert CV/Resume parser. Extract information from the following CV text and return a structured JSON.

${detectedLang !== 'English' ? `IMPORTANT: This CV appears to be in ${detectedLang}. Translate all extracted information to English.` : ''}

CV Text:
${cvText}

Return ONLY a valid JSON object with this structure:
{
    "name": "Full name",
    "email": "Email address", 
    "phone": "Phone number",
    "address": "Full address",
    "linkedin": "LinkedIn profile URL",
    "github": "GitHub profile URL",
    "website": "Personal website URL",
    "professional_specialty": "Main professional field",
    "summary": "Professional summary or objective - REQUIRED: Extract the professional summary, career objective, or about me section. If no explicit summary exists, create a brief 2-3 sentence summary based on the person's experience and skills.",
    "highest_university_degree": "Highest degree earned",
    "university_name": "University name",
    "original_language": "${detectedLang}",
    "education": [
        {
            "institution": "School/University name",
            "degree": "Degree and field",
            "start_date": "MM/YYYY",
            "end_date": "MM/YYYY or Present",
            "duration_text": "Original duration text",
            "gpa": "GPA if mentioned"
        }
    ],
    "courses_completed": [
        {
            "name": "Course name - IMPORTANT: Include ALL courses, certifications, training programs, online courses, workshops, and professional development courses. Do NOT include university degrees here.",
            "provider": "Institution/Platform/Organization that provided the course - REQUIRED: Always specify the provider (e.g., Coursera, Udemy, Google, Microsoft, local training center, etc.)",
            "completion_date": "Date if available",
            "certificate": "Certificate name or type obtained from this course"
        }
    ],
    "skills": {
        "technical_skills": ["Technical skills"],
        "programming_languages": ["Programming languages"],
        "frameworks_tools": ["Frameworks and tools"],
        "soft_skills": ["Soft skills"],
        "languages": ["Spoken languages"],
        "certifications": ["Certifications"]
    },
    "projects": [
        {
            "name": "Project name",
            "description": "Project description",
            "technologies": ["Technologies used"],
            "duration": "Project duration"
        }
    ],
    "awards": ["Awards and achievements"],
    "volunteer_work": [
        {
            "organization": "Organization name",
            "role": "Volunteer role", 
            "duration": "Duration",
            "description": "Description of work"
        }
    ]
}

CRITICAL REQUIREMENTS:
1. SUMMARY: Always provide a meaningful professional summary. Never leave this field null or empty.
2. COURSES: Extract ALL non-university courses with their providers. Be thorough in finding training, certifications, and courses.
3. Return only valid JSON, no additional text or formatting.
    `.trim();
}

function createExperienceParsingPrompt(cvText) {
    const detectedLang = detectLanguage(cvText);
    
    return `
You are an expert at extracting work experience from CVs. Extract ONLY work experience information from the following CV.

${detectedLang !== 'English' ? `IMPORTANT: This CV appears to be in ${detectedLang}. Translate all extracted information to English.` : ''}

CV Text:
${cvText}

Return ONLY a valid JSON object with this structure:
{
    "experience": [
        {
            "company": "Company name",
            "position": "Job title",
            "start_date": "MM/YYYY",
            "end_date": "MM/YYYY or Present",
            "duration_text": "Original duration text from CV",
            "years_of_experience": 2.5,
            "professional_field": "Field category",
            "description": "Job responsibilities",
            "achievements": ["Key achievements"]
        }
    ],
    "total_years_experience": 5.8,
    "primary_experience_years": 4.2,
    "primary_field": "Main professional field",
    "secondary_experience_fields": {
        "Field Name": 1.6
    }
}

CRITICAL CALCULATION REQUIREMENTS:
1. EXPERIENCE YEARS: Calculate years with decimal precision (e.g., 4.2, not 4). Use this formula:
   - For each job: (end_date - start_date) in years with months as decimals
   - Example: 2 years 3 months = 2.25 years (3/12 = 0.25)
   - Example: 1 year 6 months = 1.5 years (6/12 = 0.5)
   - If "Present", use current date for calculation

2. SECONDARY EXPERIENCE FIELDS: 
   - ONLY include actual work experience from different professional fields
   - DO NOT include education, university degrees, or academic experience
   - DO NOT include internships unless they are substantial (6+ months)
   - If there are no secondary work experience fields, return empty object: {}
   - Only count paid work experience in different industries/fields

3. FIELD CLASSIFICATION:
   - Group similar roles into the same field (e.g., "Software Developer" and "Senior Developer" = "Software Development")
   - Use broad professional categories (e.g., "Marketing", "Sales", "Engineering", "Finance")

Important: Return only valid JSON, no additional text.
    `.trim();
}

// Enhanced text extraction functions with hyperlink support
async function extractTextFromPDF(buffer) {
    try {
        console.log('📄 Extracting text and links from PDF...');
        const data = await pdfParse(buffer);
        
        // Extract text content
        let textContent = data.text;
        
        // Try to extract embedded links from PDF annotations if available
        let extractedLinks = [];
        if (pdfjsLib) {
            try {
                const loadingTask = pdfjsLib.getDocument({ data: buffer });
                const pdfDoc = await loadingTask.promise;
                const numPages = pdfDoc.numPages || 0;
                console.log(`🔍 PDF has ${numPages} pages for annotation scan`);
                for (let i = 1; i <= numPages; i++) {
                    const page = await pdfDoc.getPage(i);
                    try {
                        const annotations = await page.getAnnotations();
                        annotations.forEach(a => {
                            const url = a.url || a.URI || (typeof a.dest === 'string' && a.dest.startsWith('http') ? a.dest : null);
                            if (url && typeof url === 'string') {
                                extractedLinks.push(url);
                                console.log(`🔗 PDF annotation link (p${i}): ${url}`);
                            }
                        });
                    } catch (annInnerErr) {
                        // ignore per-page annotation failures
                    }
                }
            } catch (annErr) {
                // ignore annotation failures
            }
        }

        // Also scan text for explicit http/https URLs
        try {
            const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
            const foundUrls = textContent.match(urlRegex) || [];
            if (foundUrls.length) {
                foundUrls.forEach(u => extractedLinks.push(u));
            }
        } catch (_) { /* ignore */ }

        // If no protocol links found, try bare domains
        if (extractedLinks.length === 0) {
            const bareRegex = /(?:^|\s)((?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[\w\-./?%&=#]*)?)/g;
            let m;
            while ((m = bareRegex.exec(textContent)) !== null) {
                const candidate = (m[1] || '').trim();
                if (!candidate) continue;
                const normalized = candidate.startsWith('http://') || candidate.startsWith('https://')
                    ? candidate
                    : `https://${candidate}`;
                extractedLinks.push(normalized);
            }
        }
        
        // Deduplicate
        extractedLinks = [...new Set(extractedLinks)];

        // Add extracted links to the text content for parsing
        if (extractedLinks.length > 0) {
            textContent += '\n\nEXTRACTED LINKS:\n' + extractedLinks.join('\n');
        }
        
        console.log(`✅ PDF text extracted: ${data.text.length} characters, ${extractedLinks.length} links found`);
        return textContent;
    } catch (error) {
        console.error('❌ PDF extraction error:', error);
        throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
}

async function extractTextFromDOCX(buffer) {
    try {
        console.log('📄 Extracting text and links from DOCX...');
        
        // Extract text content
        const textResult = await mammoth.extractRawText({ buffer });
        let textContent = textResult.value;
        
        // Extract hyperlinks from DOCX
        let extractedLinks = [];
        try {
            const htmlResult = await mammoth.convertToHtml({ buffer });
            const htmlContent = htmlResult.value;
            
            // Extract href attributes from anchor tags
            const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
            let match;
            while ((match = linkRegex.exec(htmlContent)) !== null) {
                const url = match[1];
                const linkText = match[2];
                extractedLinks.push(url);
                console.log(`🔗 Found embedded link: "${linkText}" -> ${url}`);
            }
        } catch (linkError) {
            console.log('⚠️ Could not extract hyperlinks from DOCX, continuing with text only');
        }
        
        // Also look for URL patterns in the text content
        const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
        const foundUrls = textContent.match(urlRegex) || [];
        extractedLinks = [...extractedLinks, ...foundUrls];
        
        // Remove duplicates
        extractedLinks = [...new Set(extractedLinks)];
        
        // Add extracted links to the text content for parsing
        if (extractedLinks.length > 0) {
            textContent += '\n\nEXTRACTED LINKS:\n' + extractedLinks.join('\n');
        }
        
        console.log(`✅ DOCX text extracted: ${textResult.value.length} characters, ${extractedLinks.length} links found`);
        return textContent;
    } catch (error) {
        console.error('❌ DOCX extraction error:', error);
        throw new Error(`Failed to extract text from DOCX: ${error.message}`);
    }
}

async function extractTextFromTXT(buffer) {
    try {
        console.log('📄 Extracting text and links from TXT...');
        let textContent = buffer.toString('utf8');
        
        // Extract URL patterns from text content
        const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
        const foundUrls = textContent.match(urlRegex) || [];
        
        if (foundUrls.length > 0) {
            console.log(`🔗 Found ${foundUrls.length} URLs in TXT file`);
            foundUrls.forEach(url => console.log(`🔗 URL: ${url}`));
        }
        
        console.log(`✅ TXT text extracted: ${textContent.length} characters, ${foundUrls.length} links found`);
        return textContent;
    } catch (error) {
        console.error('❌ TXT extraction error:', error);
        throw new Error(`Failed to extract text from TXT: ${error.message}`);
    }
}

async function extractTextFromFile(file) {
    try {
        console.log(`📂 Reading file: ${file.path}`);
        
        if (!fs.existsSync(file.path)) {
            throw new Error(`File not found: ${file.path}`);
        }
        
        const buffer = fs.readFileSync(file.path);
        const extension = path.extname(file.originalname).toLowerCase();
        
        console.log(`🔍 File extension: ${extension}, Size: ${buffer.length} bytes`);
        
        switch (extension) {
            case '.pdf':
                return await extractTextFromPDF(buffer);
            case '.docx':
                return await extractTextFromDOCX(buffer);
            case '.txt':
                return await extractTextFromTXT(buffer);
            default:
                throw new Error(`Unsupported file type: ${extension}`);
        }
    } catch (error) {
        console.error(`❌ Error extracting text from ${file.originalname}:`, error.message);
        throw error;
    }
}

// Helper: extract URLs (LinkedIn, GitHub, Website) from plain text
function extractLinksFromText(text) {
    if (!text || typeof text !== 'string') {
        return { all: [], linkedin: null, github: null, website: null };
    }

    // Capture http/https links
    const httpRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
    // Capture bare domains like linkedin.com/in/..., github.com/..., www.example.com
    const bareRegex = /(?:^|\s)((?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[\w\-./?%&=#]*)?)/g;

    const urls = new Set();

    // Collect http/https URLs
    const httpMatches = text.match(httpRegex) || [];
    httpMatches.forEach(u => urls.add(u.trim()));

    // Collect bare domains and normalize by adding https:// if missing protocol
    let m;
    while ((m = bareRegex.exec(text)) !== null) {
        const candidate = (m[1] || '').trim();
        if (!candidate) continue;
        // Skip obvious non-URLs
        if (candidate.length < 4) continue;
        const normalized = candidate.startsWith('http://') || candidate.startsWith('https://')
            ? candidate
            : `https://${candidate}`;
        urls.add(normalized);
    }

    // Classify with preference for personal profile URLs
    let linkedin = null;
    let github = null;
    let website = null;

    // for (const url of urls) {
    //     const lower = url.toLowerCase();
    //     if (!linkedin && (lower.includes('linkedin'))) {
    //         linkedin = url;
    //         continue;
    //     }
    //     if (!github && (lower.includes('github'))) {
    //         github = url;
    //         continue;
    //     }
    // }

    const allUrls = Array.from(urls);
    // Prefer linkedin.com/in or /pub (personal profiles)
    linkedin = allUrls.find(u => /linkedin\.com\/(in|pub)\//i.test(u))
            || allUrls.find(u => /linkedin\.com\/(mwlite\/)?in\//i.test(u))
            || allUrls.find(u => /linkedin\.com\//i.test(u))
            || null;

    // Prefer github.com/<user> (not necessarily org), but accept repo links too
    github = allUrls.find(u => /github\.com\/[A-Za-z0-9_-]+(\/?$)/.test(u))
          || allUrls.find(u => /github\.com\//i.test(u))
          || null;

    // Choose a website: pick the first non-linkedin/github domain
    for (const url of urls) {
        const lower = url.toLowerCase();
        if (lower.includes('linkedin.com') || lower.includes('github.com')) continue;
        // Heuristic: prefer personal domains over generic file hosts
        website = url;
        break;
    }

    return { all: Array.from(urls), linkedin, github, website };
}

// Enhanced Python-based link extraction
async function extractLinksWithPython(filePath) {
    return new Promise((resolve, reject) => {
        console.log(`🐍 Running Python link extraction on: ${filePath}`);
        
        const pythonProcess = spawn('python', [
            path.join(__dirname, 'link_extractor.py'),
            filePath
        ]);

        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`❌ Python script failed with code ${code}`);
                console.error(`Error output: ${errorOutput}`);
                resolve({ linkedin: null, github: null, error: errorOutput });
                return;
            }

            try {
                const result = JSON.parse(output.trim());
                console.log(`✅ Python extraction result:`, result);
                resolve(result);
            } catch (parseError) {
                console.error(`❌ Failed to parse Python output:`, parseError.message);
                console.error(`Raw output: ${output}`);
                resolve({ linkedin: null, github: null, error: 'Failed to parse Python output' });
            }
        });

        pythonProcess.on('error', (error) => {
            console.error(`❌ Python process error:`, error.message);
            resolve({ linkedin: null, github: null, error: error.message });
        });
    });
}

async function callGeminiAPI(prompt, retries = 3) {
    resetDailyIfNeeded();

    if (requestsToday >= DAILY_LIMIT) {
        console.log('🚫 Daily Gemini quota reached! Wait until midnight Pacific Time.');
        throw new Error('Daily Gemini quota reached');
    }
    if (requestsThisMinute >= MINUTE_LIMIT) {
        console.log('🚫 Per-minute Gemini quota reached! Wait for next minute.');
        throw new Error('Per-minute Gemini quota reached');
    }

    requestsToday++;
    requestsThisMinute++;
    console.log(`📤 Sending Gemini request #${requestsToday} today (${requestsThisMinute} this minute)`);
    console.log(`🤖 Calling Gemini API (attempt 1/${retries})`);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: MODEL_NAME,
                generationConfig: {
                    temperature: 0.1,
                    topP: 0.8,
                    maxOutputTokens: 8192,
                }
            });
            
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            console.log(`✅ Gemini API response received: ${text.length} characters`);
            return text;
            
        } catch (error) {
            console.error(`❌ Gemini API error (attempt ${attempt}/${retries}):`, error.message);
            
            if (error.message.includes('API_KEY')) {
                throw new Error('Invalid Gemini API key. Please check your GEMINI_API_KEY environment variable.');
            }
            
            if (error.message.includes('SAFETY')) {
                throw new Error('Content was blocked by safety filters. Please try with a different CV.');
            }
            
            if (attempt === retries) {
                throw new Error(`Gemini API failed after ${retries} attempts: ${error.message}`);
            }
            
            // Wait before retry (exponential backoff)
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`⏳ Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function parseWithGemini(cvText, isExperience = false) {
    try {
        console.log(`🔄 Parsing CV text (${cvText.length} chars) - Experience: ${isExperience}`);
        
        const prompt = isExperience ? 
            createExperienceParsingPrompt(cvText) : 
            createMainParsingPrompt(cvText);
        
        const response = await callGeminiAPI(prompt);
        
        // Clean response text
        let responseText = response.trim();
        
        // Remove markdown code blocks
        if (responseText.startsWith('```json')) {
            responseText = responseText.substring(7);
        }
        if (responseText.startsWith('```')) {
            responseText = responseText.substring(3);
        }
        if (responseText.endsWith('```')) {
            responseText = responseText.slice(0, -3);
        }
        
        responseText = responseText.trim();
        console.log(`🧹 Cleaned response: ${responseText.substring(0, 200)}...`);
        
        try {
            const parsedData = JSON.parse(responseText);
            console.log(`✅ Successfully parsed JSON response`);
            return parsedData;
        } catch (parseError) {
            console.error('❌ JSON Parse Error:', parseError.message);
            console.error('Raw response:', responseText.substring(0, 500));
            throw new Error(`Invalid JSON response from AI: ${parseError.message}`);
        }
        
    } catch (error) {
        console.error('❌ Error parsing with Gemini:', error.message);
        
        // Return default structure based on parsing type
        if (isExperience) {
            return {
                experience: [],
                total_years_experience: 0,
                primary_experience_years: 0,
                primary_field: 'General',
                secondary_experience_fields: {}
            };
        } else {
            return {
                name: null,
                email: null,
                phone: null,
                address: null,
                linkedin: null,
                github: null,
                website: null,
                professional_specialty: 'General',
                summary: null,
                highest_university_degree: null,
                university_name: null,
                original_language: 'English',
                education: [],
                courses_completed: [],
                skills: {
                    technical_skills: [],
                    programming_languages: [],
                    frameworks_tools: [],
                    soft_skills: [],
                    languages: [],
                    certifications: []
                },
                projects: [],
                awards: [],
                volunteer_work: []
            };
        }
    }
}

// Database operations
function saveCVToDatabase(cvData) {
    return new Promise((resolve, reject) => {
        console.log(`💾 Saving CV to database: ${cvData.name || 'Unknown'}`);
        
        const stmt = db.prepare(`
            INSERT INTO cvs (
                filename, name, email, phone, address, linkedin, github, website,
                professional_specialty, primary_experience_years, secondary_experience_fields,
                total_years_experience, highest_university_degree, university_name,
                courses_completed, summary, experience_data, education_data, skills_data,
                projects_data, awards_data, volunteer_work_data, metadata_data, original_language
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
            cvData.metadata?.filename || 'Unknown',
            cvData.name,
            cvData.email,
            cvData.phone,
            cvData.address,
            cvData.linkedin,
            cvData.github,
            cvData.website,
            cvData.professional_specialty,
            cvData.primary_experience_years || 0,
            JSON.stringify(cvData.secondary_experience_fields || {}),
            cvData.total_years_experience || 0,
            cvData.highest_university_degree,
            cvData.university_name,
            JSON.stringify(cvData.courses_completed || []),
            cvData.summary,
            JSON.stringify(cvData.experience || []),
            JSON.stringify(cvData.education || []),
            JSON.stringify(cvData.skills || {}),
            JSON.stringify(cvData.projects || []),
            JSON.stringify(cvData.awards || []),
            JSON.stringify(cvData.volunteer_work || []),
            JSON.stringify(cvData.metadata || {}),
            cvData.original_language || 'English',
            function(err) {
                if (err) {
                    console.error('❌ Database save error:', err.message);
                    reject(err);
                } else {
                    console.log(`✅ CV saved to database with ID: ${this.lastID}`);
                    resolve(this.lastID);
                }
            }
        );
        
        stmt.finalize();
    });
}

function getAllCVsFromDatabase() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM cvs ORDER BY created_at DESC", (err, rows) => {
            if (err) {
                console.error('❌ Database query error:', err.message);
                reject(err);
            } else {
                console.log(`📊 Retrieved ${rows.length} CVs from database`);
                const cvs = rows.map(row => {
                    try {
                        return {
                            id: row.id,
                            filename: row.filename,
                            name: row.name,
                            email: row.email,
                            phone: row.phone,
                            address: row.address,
                            linkedin: row.linkedin,
                            github: row.github,
                            website: row.website,
                            professional_specialty: row.professional_specialty,
                            primary_experience_years: row.primary_experience_years || 0,
                            secondary_experience_fields: JSON.parse(row.secondary_experience_fields || '{}'),
                            total_years_experience: row.total_years_experience || 0,
                            highest_university_degree: row.highest_university_degree,
                            university_name: row.university_name,
                            courses_completed: JSON.parse(row.courses_completed || '[]'),
                            summary: row.summary,
                            experience: JSON.parse(row.experience_data || '[]'),
                            education: JSON.parse(row.education_data || '[]'),
                            skills: JSON.parse(row.skills_data || '{}'),
                            projects: JSON.parse(row.projects_data || '[]'),
                            awards: JSON.parse(row.awards_data || '[]'),
                            volunteer_work: JSON.parse(row.volunteer_work_data || '[]'),
                            original_language: row.original_language || 'English',
                            metadata: JSON.parse(row.metadata_data || '{}'),
                            created_at: row.created_at,
                            updated_at: row.updated_at
                        };
                    } catch (parseError) {
                        console.error(`❌ Error parsing CV data for ID ${row.id}:`, parseError.message);
                        return null;
                    }
                }).filter(cv => cv !== null);
                
                resolve(cvs);
            }
        });
    });
}

// Utility function to clean up uploaded files
function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Cleaned up file: ${filePath}`);
        }
    } catch (error) {
        console.error(`❌ Error cleaning up file ${filePath}:`, error.message);
    }
}

// API Routes
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from API!" });
});

// Health check with detailed status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: 'render-server',
    geminiConfigured: !!process.env.GEMINI_API_KEY
  });
    
    console.log('🏥 Health check requested:', status);
    res.json(status);
});

// Upload and parse CVs with enhanced debugging
app.post('/api/parse-cvs', upload.array('files'), async (req, res) => {
    console.log('🚀 CV parsing request received');
    console.log(`📁 Files in request:`, req.files?.length || 0);
    
    let uploadedFiles = [];
    
    try {
        if (!req.files || req.files.length === 0) {
            console.log('❌ No files in request');
            return res.status(400).json({ 
                error: 'No files uploaded',
                debug: {
                    files: req.files,
                    body: req.body
                }
            });
        }

        uploadedFiles = req.files.map(f => f.path);
        console.log(`📂 Processing ${req.files.length} files:`, req.files.map(f => f.originalname));
        
        const results = [];
        const errors = [];
        
        for (const file of req.files) {
            try {
                console.log(`\n📄 Processing: ${file.originalname}`);
                console.log(`📊 File info: ${file.size} bytes, ${file.mimetype}`);
                
                // Extract text from file
                const cvText = await extractTextFromFile(file);
                
                if (!cvText || cvText.trim().length < 50) {
                    console.log(`❌ Insufficient text extracted from ${file.originalname}: ${cvText?.length || 0} chars`);
                    errors.push(`Could not extract sufficient text from ${file.originalname}. File may be image-based or corrupted.`);
                    continue;
                }
                
                console.log(`📊 Extracted ${cvText.length} characters from ${file.originalname}`);
                console.log(`📝 Sample text: ${cvText.substring(0, 200)}...`);
                
                // Parse main CV data
                console.log('🤖 Parsing main CV data...');
                const mainData = await parseWithGemini(cvText, false);
                
                // Parse experience separately
                console.log('🤖 Parsing experience data...');
                const experienceData = await parseWithGemini(cvText, true);
                
                // Extract URLs directly from text as a fallback if AI missed them
                const urlInfo = extractLinksFromText(cvText);
                
                // Enhanced Python-based link extraction
                console.log('🐍 Running enhanced Python link extraction...');
                const pythonLinks = await extractLinksWithPython(file.path);
                
                // Combine the data with priority: Python extraction > AI extraction > text extraction
                const combinedData = {
                    ...mainData,
                    // Use the most reliable source for each link type
                    linkedin: pythonLinks.linkedin || mainData.linkedin || urlInfo.linkedin || null,
                    github: pythonLinks.github || mainData.github || urlInfo.github || null,
                    website: mainData.website || urlInfo.website || null,
                    experience: experienceData.experience || [],
                    total_years_experience: experienceData.total_years_experience || 0,
                    primary_experience_years: experienceData.primary_experience_years || 0,
                    primary_field: experienceData.primary_field || 'General',
                    secondary_experience_fields: experienceData.secondary_experience_fields || {},
                    metadata: {
                        filename: file.originalname,
                        file_size: file.size,
                        processed_at: new Date().toISOString(),
                        parsing_method: 'enhanced_ai_analysis',
                        text_length: cvText.length,
                        extracted_links: urlInfo.all
                    }
                };
                
                console.log('💾 Saving to database...');
                const cvId = await saveCVToDatabase(combinedData);
                combinedData.id = cvId;
                
                results.push(combinedData);
                console.log(`✅ Successfully processed: ${file.originalname}`);
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ Error processing ${file.originalname}:`, error.message);
                console.error('Stack trace:', error.stack);
                errors.push(`Failed to process ${file.originalname}: ${error.message}`);
            }
        }
        
        // Clean up uploaded files
        uploadedFiles.forEach(cleanupFile);
        
        console.log(`📊 Processing complete. Success: ${results.length}, Errors: ${errors.length}`);
        
        if (results.length === 0 && errors.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'No CVs parsed successfully',
                message: 'All files failed to process. Check the error details.',
                errors: errors
            });
        }

        const response = {
            success: true,
            message: `Successfully parsed ${results.length} CV${results.length !== 1 ? 's' : ''}`,
            data: results,
            processed: results.length,
            total: req.files.length
        };
        
        if (errors.length > 0) {
            response.warnings = errors;
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Parse CVs critical error:', error);
        console.error('Stack trace:', error.stack);
        
        // Clean up uploaded files on error
        uploadedFiles.forEach(cleanupFile);
        
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message,
            debug: process.env.NODE_ENV === 'development' ? {
                stack: error.stack,
                files: req.files?.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype }))
            } : undefined
        });
    }
});

// Get all CVs from database
app.get('/api/cvs', async (req, res) => {
    try {
        console.log('📊 Fetching all CVs from database...');
        const cvs = await getAllCVsFromDatabase();
        res.json({
            success: true,
            data: cvs,
            count: cvs.length
        });
    } catch (error) {
        console.error('❌ Get CVs error:', error.message);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Delete a CV
app.delete('/api/cvs/:id', (req, res) => {
    const cvId = req.params.id;
    console.log(`🗑️ Deleting CV with ID: ${cvId}`);
    
    if (!cvId || isNaN(cvId)) {
        return res.status(400).json({ error: 'Invalid CV ID' });
    }
    
    db.run("DELETE FROM cvs WHERE id = ?", [cvId], function(err) {
        if (err) {
            console.error('❌ Delete CV error:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        } else if (this.changes === 0) {
            console.log(`❌ CV not found: ${cvId}`);
            res.status(404).json({ error: 'CV not found' });
        } else {
            console.log(`✅ CV deleted: ${cvId}`);
            res.json({
                success: true,
                message: 'CV deleted successfully',
                deletedId: cvId
            });
        }
    });
});

// Clear all CVs
app.delete('/api/cvs', (req, res) => {
    console.log('🗑️ Clearing all CVs from database...');

    db.serialize(() => {
        db.run("DELETE FROM cvs", function(err) {
            if (err) {
                console.error('❌ Clear CVs error:', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }

            const deleted = this.changes || 0;
            console.log(`✅ Cleared ${deleted} CVs from database`);

            // Reset AUTOINCREMENT sequence so IDs start from 1 next time
            db.run("DELETE FROM sqlite_sequence WHERE name='cvs'", function(seqErr) {
                if (seqErr) {
                    console.warn('⚠️ Could not reset sqlite_sequence:', seqErr.message);
                } else {
                    console.log('🔢 AUTOINCREMENT sequence for table cvs reset.');
                }

                // Optional: reclaim space
                db.run('VACUUM', function(vacErr) {
                    if (vacErr) {
                        console.warn('⚠️ VACUUM failed:', vacErr.message);
                    }

                    return res.json({
                        success: true,
                        message: 'All CVs cleared successfully and ID sequence reset',
                        deletedCount: deleted,
                        idReset: true
                    });
                });
            });
        });
    });
});

// Get single CV details by ID
app.get('/api/cvs/:id', async (req, res) => {
    try {
        const cvId = parseInt(req.params.id);
        console.log(`📄 Fetching CV details for ID: ${cvId}`);
        
        if (!cvId || isNaN(cvId)) {
            return res.status(400).json({ error: 'Invalid CV ID' });
        }

        db.get("SELECT * FROM cvs WHERE id = ?", [cvId], (err, row) => {
            if (err) {
                console.error('❌ Get CV details error:', err.message);
                res.status(500).json({ error: 'Internal server error' });
            } else if (!row) {
                console.log(`❌ CV not found: ${cvId}`);
                res.status(404).json({ error: 'CV not found' });
            } else {
                try {
                    const cvDetails = {
                        id: row.id,
                        filename: row.filename,
                        name: row.name,
                        email: row.email,
                        phone: row.phone,
                        address: row.address,
                        linkedin: row.linkedin,
                        github: row.github,
                        website: row.website,
                        professional_specialty: row.professional_specialty,
                        primary_experience_years: row.primary_experience_years || 0,
                        secondary_experience_fields: JSON.parse(row.secondary_experience_fields || '{}'),
                        total_years_experience: row.total_years_experience || 0,
                        highest_university_degree: row.highest_university_degree,
                        university_name: row.university_name,
                        courses_completed: JSON.parse(row.courses_completed || '[]'),
                        summary: row.summary,
                        experience: JSON.parse(row.experience_data || '[]'),
                        education: JSON.parse(row.education_data || '[]'),
                        skills: JSON.parse(row.skills_data || '{}'),
                        projects: JSON.parse(row.projects_data || '[]'),
                        awards: JSON.parse(row.awards_data || '[]'),
                        volunteer_work: JSON.parse(row.volunteer_work_data || '[]'),
                        original_language: row.original_language || 'English',
                        metadata: JSON.parse(row.metadata_data || '{}'),
                        created_at: row.created_at,
                        updated_at: row.updated_at
                    };
                    
                    console.log(`✅ CV details fetched for: ${cvDetails.name || 'Unknown'}`);
                    res.json({
                        success: true,
                        cv: cvDetails
                    });
                } catch (parseError) {
                    console.error(`❌ Error parsing CV data for ID ${cvId}:`, parseError.message);
                    res.status(500).json({ error: 'Error parsing CV data' });
                }
            }
        });
    } catch (error) {
        console.error('❌ Get CV details error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// **AI Candidate Matching Endpoint (exact as requested)**
app.post('/api/match-candidates', async (req, res) => {
    try {
        const { requirements, cvs } = req.body;
        
        if (!requirements || !cvs || cvs.length === 0) {
            return res.status(400).json({ error: 'Requirements and CVs are required' });
        }

        console.log(`Matching ${cvs.length} candidates against requirements...`);
        
        const matches = [];
        
        for (const candidate of cvs) {
            try {
                const matchResult = await analyzeMatch(candidate, requirements);
                matches.push({
                    cv: candidate,
                    percentage: matchResult.percentage,
                    reasoning: matchResult.reasoning,
                    matchedSkills: matchResult.matchedSkills,
                    missingCritical: matchResult.missingCritical || [],
                    transferableSkills: matchResult.transferableSkills || []
                });
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`Error matching candidate ${candidate.name}:`, error);
                // Add candidate with 0% match if analysis fails
                matches.push({
                    cv: candidate,
                    percentage: 0,
                    reasoning: 'Analysis failed - please try again',
                    matchedSkills: []
                });
            }
        }
        
        // Sort matches by percentage (highest first)
        matches.sort((a, b) => b.percentage - a.percentage);
        
        res.json({
            success: true,
            matches: matches,
            totalAnalyzed: cvs.length
        });
        
    } catch (error) {
        console.error('Match candidates error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper function to parse job requirements text into structured format
function parseJobRequirements(requirementsText) {
    const requirements = [];
    const text = requirementsText.toLowerCase();
    
    // Common tech skills with their typical importance levels
    const skillImportance = {
        // Frontend
        'react': 1.0, 'vue': 1.0, 'angular': 1.0, 'javascript': 0.9,
        'html': 0.7, 'css': 0.7, 'typescript': 0.8,
        
        // Backend
        'node.js': 1.0, 'python': 1.0, 'java': 1.0, 'php': 1.0,
        'express': 0.8, 'django': 0.8, 'spring': 0.8,
        
        // Databases
        'mongodb': 0.8, 'postgresql': 0.8, 'mysql': 0.7, 'redis': 0.6,
        
        // Cloud & DevOps
        'aws': 0.9, 'docker': 0.8, 'kubernetes': 0.7, 'azure': 0.8,
        
        // Full Stack
        'fullstack': 1.0, 'full-stack': 1.0, 'full stack': 1.0
    };

    // Proficiency level requirements
    const proficiencyLevels = {
        'senior': 0.8, 'expert': 0.9, 'advanced': 0.8,
        'intermediate': 0.6, 'junior': 0.4, 'entry': 0.3
    };

    // Extract skills mentioned in requirements
    Object.keys(skillImportance).forEach(skill => {
        if (text.includes(skill)) {
            let importance = skillImportance[skill];
            let minLevel = 0.6; // Default minimum level
            
            // Check for proficiency indicators
            Object.keys(proficiencyLevels).forEach(level => {
                if (text.includes(level)) {
                    minLevel = proficiencyLevels[level];
                    if (level === 'senior' || level === 'expert') {
                        importance = Math.min(1.0, importance + 0.1);
                    }
                }
            });

            requirements.push({
                skill: skill,
                importance: importance,
                minLevel: minLevel
            });
        }
    });

    // If no structured requirements found, create from keywords
    if (requirements.length === 0) {
        const words = text.split(/\s+/).filter(w => w.length > 2);
        words.forEach(word => {
            if (skillImportance[word]) {
                requirements.push({
                    skill: word,
                    importance: skillImportance[word],
                    minLevel: 0.5
                });
            }
        });
    }

    // Expansion: if only generic role keywords are present (e.g., "full stack", "frontend", "backend")
    // and there are fewer than 3 explicit tech skills, inject representative proxies
    const hasFullStack = text.includes('full stack') || text.includes('full-stack') || text.includes('fullstack');
    const hasFrontend = text.includes('front end') || text.includes('frontend');
    const hasBackend = text.includes('back end') || text.includes('backend');

    const explicitTechs = requirements.filter(r => !['full stack','full-stack','fullstack','frontend','front end','backend','back end'].includes(r.skill));
    if ((hasFullStack || hasFrontend || hasBackend) && explicitTechs.length < 3) {
        const ensure = (skill, importance) => {
            if (!requirements.some(r => r.skill === skill)) {
                requirements.push({ skill, importance, minLevel: 0.6 });
            }
        };

        // Frontend proxies
        if (hasFullStack || hasFrontend) {
            ensure('react', 0.9);
            ensure('javascript', 0.85);
            ensure('html', 0.6);
            ensure('css', 0.6);
            ensure('typescript', 0.7);
        }

        // Backend proxies
        if (hasFullStack || hasBackend) {
            ensure('node.js', 0.9);
            ensure('express', 0.7);
            ensure('postgresql', 0.7);
            ensure('mongodb', 0.7);
        }

        // DevOps proxies (lighter)
        if (hasFullStack) {
            ensure('docker', 0.6);
            ensure('aws', 0.6);
        }
    }

    return requirements;
}

// Deterministic extraction of requirement skills present in a CV
// Used to stabilize AI outputs and avoid flat scoring.
function extractSkillsFromCV(cv, structuredRequirements = []) {
    const norm = (s) => (s || '').toString().trim().toLowerCase();

    // Map common synonyms to canonical forms
    const canonical = (s) => {
        const x = norm(s);
        if (x === 'node' || x === 'nodejs') return 'node.js';
        if (x === 'postgres' || x === 'postgresql') return 'postgresql';
        if (x === 'js') return 'javascript';
        if (x === 'fullstack' || x === 'full-stack' || x === 'full stack') return 'fullstack';
        if (x === 'front end') return 'frontend';
        if (x === 'back end') return 'backend';
        return x;
    };

    // Collect text sources from the CV
    const parts = [];
    if (cv.summary) parts.push(cv.summary);
    if (Array.isArray(cv.experience)) {
        cv.experience.forEach(e => {
            if (e.position) parts.push(e.position);
            if (e.company) parts.push(e.company);
            if (e.description) parts.push(e.description);
        });
    }

    // Flatten skills buckets from cv.skills
    const skillBuckets = cv.skills ? Object.values(cv.skills).flat() : [];
    const explicitSkills = new Set(skillBuckets.map(s => canonical(s)));

    const fullText = norm(parts.join('\n'));

    const matched = new Set();
    (structuredRequirements || []).forEach(r => {
        const req = canonical(r.skill);

        // Direct skills presence
        if (explicitSkills.has(req)) {
            matched.add(req);
            return;
        }

        // Fuzzy text match with word boundaries where possible
        // Allow partial contains for dotted skills like node.js
        const esc = req.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordBoundary = /[a-z0-9]/.test(req) && !req.includes('.') ? `(?<![a-z0-9])${esc}(?![a-z0-9])` : esc;
        try {
            const re = new RegExp(wordBoundary, 'i');
            if (re.test(fullText)) {
                matched.add(req);
                return;
            }
        } catch (_) {
            // Fallback to simple includes if regex fails
            if (fullText.includes(req)) matched.add(req);
        }

        // Simple synonym contains (e.g., node vs node.js)
        if (req === 'node.js' && (explicitSkills.has('node') || fullText.includes('node'))) matched.add(req);
        if (req === 'javascript' && (explicitSkills.has('js') || fullText.includes(' js '))) matched.add(req);
    });

    return Array.from(matched);
}

// Build a concise, informative summary for AI scoring
function buildCandidateSummary(cv) {
    const lines = [];
    lines.push(`Name: ${cv.name || 'Unknown'}`);
    if (cv.professional_specialty) lines.push(`Specialty: ${cv.professional_specialty}`);
    if (typeof cv.total_years_experience === 'number') lines.push(`Total Experience: ${cv.total_years_experience} years`);
    if (cv.summary) lines.push(`Summary: ${cv.summary}`);

    // Education (top one)
    if (Array.isArray(cv.education) && cv.education.length) {
        const edu = cv.education[0];
        const eduStr = [edu.degree, edu.field, edu.institution].filter(Boolean).join(', ');
        if (eduStr) lines.push(`Education: ${eduStr}`);
    }

    // Skills (flatten & unique limited)
    const skillBuckets = cv.skills ? Object.values(cv.skills).flat() : [];
    const uniqueSkills = Array.from(new Set(skillBuckets.filter(Boolean).map(s => s.toString()))).slice(0, 25);
    if (uniqueSkills.length) lines.push(`Skills: ${uniqueSkills.join(', ')}`);

    // Experience highlights (up to 3)
    if (Array.isArray(cv.experience) && cv.experience.length) {
        const parts = cv.experience.slice(0, 3).map(e => {
            const role = [e.position, e.company].filter(Boolean).join(' @ ');
            const techs = (e.description || '').toString().slice(0, 180);
            return `${role}: ${techs}`;
        });
        if (parts.length) lines.push(`Experience: ${parts.join(' | ')}`);
    }

    return lines.join('\n');
}

function createAIScoringPrompt(requirementsText, candidateSummary, structuredRequirements = []) {
    const structuredBlock = JSON.stringify(structuredRequirements, null, 2);
    return `You are an expert technical recruiter. Score this candidate against the job using the rubric below. Be strict and use the full 0–100 scale.

JOB REQUIREMENTS (free-text):
"""
${requirementsText}
"""

JOB REQUIREMENTS (structured, each has skill, importance [0..1], minLevel [0..1]):
${structuredBlock}

CANDIDATE PROFILE SUMMARY:
"""
${candidateSummary}
"""

Rubric: compute subscores then final score.
- must_have_coverage (0–100): Coverage of high-importance requirements (importance >= 0.9). 100 only if all such requirements are clearly present.
- overall_requirements_coverage (0–100): Weighted coverage across ALL structured requirements based on importance.
- seniority_fit (0–100): How well seniority implied by requirements matches candidate's experience and roles.
- domain_alignment (0–100): Does candidate's professional specialty and recent roles align with the role focus (e.g., frontend/backend/full stack/data)?
- recency (0–100): Are the key skills present in recent/current roles?
- penalties (array of strings): List concrete gaps; missing must-haves should be included.

Final score formula (before penalties):
  base = 0.50*overall_requirements_coverage + 0.25*must_have_coverage + 0.10*seniority_fit + 0.10*domain_alignment + 0.05*recency
Penalty rules:
  - If any must-have is missing, subtract 15 points per missing must-have (cap total penalty at 40).
  - If seniority clearly mismatches (e.g., required senior, candidate junior), subtract 10.

Scale guidance:
- 90–100: All must-haves present, strong alignment, no major risks.
- 80–89: Most requirements covered; at most one moderate gap.
- 60–79: Partial coverage; multiple gaps or weaker alignment.
- 40–59: Limited relevance.
- <40: Poor fit.

Respond strictly in JSON with this schema:
{
  "score": number,                     // 0–100 after penalties
  "rationale": "short justification",
  "matched_skills": ["skill1", "skill2"],
  "risks": ["gap 1", "gap 2"],
  "seniority": "junior|mid|senior|lead|principal",
  "subscores": {
    "must_have_coverage": number,
    "overall_requirements_coverage": number,
    "seniority_fit": number,
    "domain_alignment": number,
    "recency": number,
    "penalty_applied": number
  }
}`.trim();
}

async function scoreCandidateWithAI(cv, requirementsText, structuredRequirements = []) {
    const summary = buildCandidateSummary(cv);
    const prompt = createAIScoringPrompt(requirementsText, summary, structuredRequirements);

    // Use existing callGeminiAPI + guard with timeout
    const raw = await withTimeout(callGeminiAPI(prompt), 30000, 'ai_scoring');
    let text = (raw || '').trim();

    // Strip code fences if any
    if (text.startsWith('```json')) text = text.slice(7);
    if (text.startsWith('```')) text = text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, -3);
    text = text.trim();

    try {
        const parsed = JSON.parse(text);
        // Normalize
        return {
            score: typeof parsed.score === 'number' ? parsed.score : 0,
            rationale: parsed.rationale || parsed.reason || '',
            matched_skills: Array.isArray(parsed.matched_skills) ? parsed.matched_skills : [],
            risks: Array.isArray(parsed.risks) ? parsed.risks : [],
            seniority: parsed.seniority || null,
            subscores: parsed.subscores || null,
            raw: parsed
        };
    } catch (e) {
        console.error('❌ AI scoring JSON parse error:', e.message);
        console.error('Raw AI response:', text.substring(0, 500));
        throw new Error('Invalid AI response');
    }
}

// Post-process AI result to avoid flat scores by enforcing must-have penalties
function recalibrateAIScore(aiScore, structuredReqs = [], foundSkills = []) {
    const out = { ...aiScore };
    // Merge AI matched skills with deterministic found skills
    const matched = new Set([
        ...((out.matched_skills || []).map(s => s.toString().toLowerCase())),
        ...((foundSkills || []).map(s => s.toString().toLowerCase()))
    ]);
    const mustHaves = (structuredReqs || []).filter(r => (r.importance || 0) >= 0.9);

    let missingMust = 0;
    mustHaves.forEach(r => {
        const key = (r.skill || '').toString().toLowerCase();
        // consider partial contains for cases like node vs node.js
        const found = Array.from(matched).some(ms => ms === key || ms.includes(key) || key.includes(ms));
        if (!found) missingMust += 1;
    });

    const penalty = Math.min(40, missingMust * 15);
    let finalScore = typeof out.score === 'number' ? out.score : 0;
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore - penalty)));

    // Hard gate: if any must-have is missing, cap below interview threshold
    if (missingMust > 0) {
        finalScore = Math.min(finalScore, 49);
        const note = ` Missing must-have(s): ${missingMust}.`;
        out.rationale = (out.rationale || 'AI analysis result') + note;
    }

    // If model provided overall coverage, lightly blend it
    const cov = out.subscores?.overall_requirements_coverage;
    if (typeof cov === 'number') {
        finalScore = Math.round(0.8 * finalScore + 0.2 * Math.max(0, Math.min(100, cov)));
    }

    // If matched skills is empty and there are requirements, push down
    if (matched.size === 0 && (structuredReqs || []).length > 0) {
        finalScore = Math.min(finalScore, 55);
    }

    // Scale by deterministic coverage to avoid clustering around ~85%
    const reqCount = (structuredReqs || []).length;
    if (reqCount > 0) {
        const coverageRatio = Math.max(0, Math.min(1, matched.size / reqCount));
        // Ensure low coverage reduces score noticeably; high coverage maintains it
        // Scale between 0.5x (0 coverage) and 1.0x (full coverage)
        const scale = 0.5 + 0.5 * coverageRatio;
        finalScore = Math.round(finalScore * scale);
    }

    return {
        ...out,
        score: finalScore,
        rationale: out.rationale || 'AI analysis result',
        matched_skills: Array.isArray(out.matched_skills) ? out.matched_skills.slice(0, 10) : []
    };
}

// Helper function to convert your CV format to the matcher's expected format
function convertCvToProfile(cv) {
    // Extract current role information
    const currentRole = cv.experience && cv.experience.length > 0 ? 
        cv.experience.find(exp => exp.current) || cv.experience[0] : {};

    // Combine all skills into different categories
    const allSkills = cv.skills ? Object.values(cv.skills).flat().filter(Boolean) : [];
    
    return {
        jobTitle: currentRole.position || cv.professional_specialty || '',
        summary: cv.summary || '',
        professional_specialty: cv.professional_specialty,
        primarySkills: allSkills.slice(0, 5), // First 5 as primary
        currentRole: {
            title: currentRole.position || '',
            duration: currentRole.duration || '',
            technologies: extractTechnologies(currentRole.description || ''),
            current: true
        },
        recentExperience: cv.experience ? cv.experience.slice(0, 3) : [],
        previousRoles: cv.experience ? cv.experience.slice(1) : [],
        additionalSkills: allSkills.slice(5), // Rest as additional
        education: cv.education || [],
        certifications: cv.courses_completed || []
    };
}

// Helper to extract technologies from text
function extractTechnologies(text) {
    const techKeywords = [
        'javascript', 'python', 'java', 'react', 'node.js', 'angular', 'vue',
        'php', 'ruby', 'go', 'rust', 'swift', 'kotlin', 'typescript',
        'mongodb', 'postgresql', 'mysql', 'redis', 'aws', 'azure', 'docker'
    ];
    
    const found = [];
    const lowerText = text.toLowerCase();
    
    techKeywords.forEach(tech => {
        if (lowerText.includes(tech)) {
            found.push(tech);
        }
    });
    
    return found;
}

// Helper to generate human-readable reasoning
function generateReasoning(skillBreakdown) {
    const matched = Object.entries(skillBreakdown)
        .filter(([skill, data]) => data.percentage > 0)
        .sort((a, b) => b[1].percentage - a[1].percentage);

    if (matched.length === 0) return "No relevant skills found";

    const topSkills = matched.slice(0, 3).map(([skill, data]) => 
        `${skill} (${data.percentage}%)`
    );

    const coverage = Math.round(matched.length / Object.keys(skillBreakdown).length * 100);
    
    return `${coverage}% requirement coverage. Strongest: ${topSkills.join(', ')}`;
}

// Helper to get matched skills list
function getMatchedSkills(skillBreakdown) {
    return Object.entries(skillBreakdown)
        .filter(([skill, data]) => data.percentage > 0)
        .map(([skill, data]) => skill)
        .slice(0, 10);
}

// Export CVs to Excel
app.get('/api/export/excel', async (req, res) => {
    try {
        console.log('📊 Excel export request received');
        
        // Get all CVs from database
        const cvs = await getAllCVsFromDatabase();
        
        if (cvs.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No CVs found',
                message: 'No CVs available to export. Please parse some CVs first.'
            });
        }
        
        // Create Excel exporter and export data
        const exporter = new CVExcelExporter();
        const result = await exporter.exportToExcel(cvs);
        
        if (result.success) {
            console.log(`✅ Excel export successful: ${result.filePath}`);
            
            // Send file to client
            res.download(result.filePath, `cv_analysis_${new Date().toISOString().slice(0, 10)}.xlsx`, (err) => {
                if (err) {
                    console.error('❌ Error sending Excel file:', err);
                } else {
                    // Clean up the temporary file after sending
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(result.filePath)) {
                                fs.unlinkSync(result.filePath);
                                console.log(`🗑️ Cleaned up Excel file: ${result.filePath}`);
                            }
                        } catch (cleanupError) {
                            console.error('❌ Error cleaning up Excel file:', cleanupError);
                        }
                    }, 5000); // Wait 5 seconds before cleanup
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Excel export failed',
                message: result.error
            });
        }
        
    } catch (error) {
        console.error('❌ Excel export error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Export matching results to Excel
app.post('/api/export/matching-results', async (req, res) => {
    try {
        console.log('📊 Matching results Excel export request received');
        
        const { matchingResults } = req.body;
        
        if (!matchingResults || !Array.isArray(matchingResults) || matchingResults.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No matching results provided',
                message: 'Please provide matching results data to export.'
            });
        }
        
        // Create Excel exporter and export matching results
        const exporter = new CVExcelExporter();
        const result = await exporter.exportMatchingResults(matchingResults);
        
        if (result.success) {
            console.log(`✅ Matching results Excel export successful: ${result.filePath}`);
            
            // Send file to client
            res.download(result.filePath, `cv_matching_results_${new Date().toISOString().slice(0, 10)}.xlsx`, (err) => {
                if (err) {
                    console.error('❌ Error sending Excel file:', err);
                } else {
                    // Clean up the temporary file after sending
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(result.filePath)) {
                                fs.unlinkSync(result.filePath);
                                console.log(`🗑️ Cleaned up Excel file: ${result.filePath}`);
                            }
                        } catch (cleanupError) {
                            console.error('❌ Error cleaning up Excel file:', cleanupError);
                        }
                    }, 5000);
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Excel export failed',
                message: result.error
            });
        }
        
    } catch (error) {
        console.error('❌ Matching results Excel export error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Bulk link extraction endpoint for existing CVs
app.post('/api/extract-links-bulk', async (req, res) => {
    try {
        console.log('🔗 Bulk link extraction request received');
        
        // Get all CVs from database
        const cvs = await getAllCVsFromDatabase();
        
        if (cvs.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No CVs found',
                message: 'No CVs available for link extraction.'
            });
        }
        
        const results = [];
        const errors = [];
        
        // Process each CV file in uploads folder
        for (const cv of cvs) {
            try {
                const filePath = path.join(uploadsDir, cv.filename);
                
                if (fs.existsSync(filePath)) {
                    console.log(`🔗 Extracting links from: ${cv.filename}`);
                    const pythonLinks = await extractLinksWithPython(filePath);
                    
                    results.push({
                        id: cv.id,
                        filename: cv.filename,
                        name: cv.name,
                        linkedin: pythonLinks.linkedin || cv.linkedin,
                        github: pythonLinks.github || cv.github,
                        extracted: {
                            linkedin: pythonLinks.linkedin,
                            github: pythonLinks.github
                        },
                        updated: !!(pythonLinks.linkedin || pythonLinks.github)
                    });
                    
                    // Update database if new links found
                    if (pythonLinks.linkedin || pythonLinks.github) {
                        const updateStmt = db.prepare(`
                            UPDATE cvs SET 
                                linkedin = COALESCE(?, linkedin),
                                github = COALESCE(?, github),
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                        `);
                        
                        updateStmt.run(
                            pythonLinks.linkedin,
                            pythonLinks.github,
                            cv.id
                        );
                        updateStmt.finalize();
                    }
                } else {
                    console.log(`⚠️ File not found: ${cv.filename}`);
                    errors.push(`File not found: ${cv.filename}`);
                }
                
                // Small delay to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`❌ Error processing ${cv.filename}:`, error.message);
                errors.push(`Failed to process ${cv.filename}: ${error.message}`);
            }
        }
        
        console.log(`📊 Bulk link extraction complete. Processed: ${results.length}, Errors: ${errors.length}`);
        
        res.json({
            success: true,
            message: `Processed ${results.length} CVs for link extraction`,
            data: results,
            processed: results.length,
            total: cvs.length,
            errors: errors.length > 0 ? errors : undefined
        });
        
    } catch (error) {
        console.error('❌ Bulk link extraction error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Test endpoint to check file upload
app.post('/api/test-upload', upload.array('files'), (req, res) => {
    console.log('🧪 Test upload endpoint called');
    console.log('Files received:', req.files?.length || 0);
    console.log('Body:', req.body);
    
    if (req.files && req.files.length > 0) {
        const fileInfo = req.files.map(f => ({
            originalname: f.originalname,
            mimetype: f.mimetype,
            size: f.size,
            path: f.path
        }));
        
        // Clean up test files
        req.files.forEach(f => cleanupFile(f.path));
        
        res.json({
            success: true,
            message: 'File upload test successful',
            files: fileInfo
        });
    } else {
        res.json({
            success: false,
            message: 'No files received',
            files: []
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ 
                error: 'File too large',
                message: 'File size exceeds 20MB limit'
            });
        }
        return res.status(400).json({ 
            error: 'File upload error',
            message: error.message
        });
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    });
});

// 404 handler
app.use('*', (req, res) => {
    console.log(`❌ 404 - Endpoint not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.originalUrl,
        method: req.method
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 Enhanced CV Parser Pro Server - FIXED VERSION');
    console.log(`📍 Server running on port ${PORT}`);
    console.log(`📊 Database: ${dbPath}`);
    console.log(`🤖 Gemini API: ${GEMINI_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`📁 Uploads directory: ${uploadsDir}`);
    console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
    
    console.log('\n📋 Available API Endpoints:');
    console.log('  GET    /api/health          - Server health check');
    console.log('  GET    /api/cvs             - Get all CVs from database');
    console.log('  GET    /api/cvs/:id         - Get single CV details');
    console.log('  POST   /api/match-candidates- AI/simple matching (returns 70%+ only)');
    console.log('  POST   /api/parse-cvs       - Upload and parse CV files');
    console.log('  POST   /api/test-upload     - Test file upload functionality');
    console.log('  DELETE /api/cvs/:id         - Delete specific CV');
    console.log('  DELETE /api/cvs             - Clear all CVs');
    
    console.log('\n🔧 Debugging Features:');
    console.log('  ✅ Enhanced logging and error messages');
    console.log('  ✅ File upload validation and debugging');
    console.log('  ✅ Gemini API error handling');
    console.log('  ✅ Text extraction debugging');
    console.log('  ✅ Database operation logging');
    console.log('  ✅ CORS configuration for development');
    
    console.log('\n🚨 Troubleshooting Steps:');
    console.log('  1. Check that GEMINI_API_KEY is set in .env file');
    console.log('  2. Verify uploads directory exists and is writable');
    console.log('  3. Test with /api/test-upload endpoint first');
    console.log('  4. Check browser network tab for detailed error messages');
    console.log('  5. Monitor console logs for debugging information');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    db.close((err) => {
        if (err) {
            console.error('❌ Error closing database:', err.message);
        } else {
            console.log('📊 Database connection closed.');
        }
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;