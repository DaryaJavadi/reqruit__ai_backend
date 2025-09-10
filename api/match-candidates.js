import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Enhanced AI Matching Analysis Function for Serverless
async function analyzeMatch(candidate, requirements) {
    const prompt = `
Your job is to evaluate how suitable each candidate is for a given role. 
Do not just match keywords — use reasoning about skill similarity, job title equivalence, and transferable experience.

JOB REQUIREMENTS:
${requirements}

CANDIDATE PROFILE:
${JSON.stringify(candidate, null, 2)}

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
`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        
        const cleanedText = text.replace(/```json\s*|\s*```/g, '').trim();
        return JSON.parse(cleanedText);
    } catch (error) {
        console.error('Gemini API error:', error);
        throw new Error('AI analysis failed');
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { requirements, cvs } = req.body;

        if (!requirements || !cvs || !Array.isArray(cvs)) {
            return res.status(400).json({ 
                error: 'Missing required fields: requirements and cvs array' 
            });
        }

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ 
                error: 'Gemini API key not configured' 
            });
        }

        // Process all candidates
        const results = [];
        for (const cv of cvs) {
            try {
                const analysis = await analyzeMatch(cv, requirements);
                
                // Only include candidates with 70%+ match
                if (analysis.percentage >= 70) {
                    results.push({
                        id: cv.id,
                        name: cv.name,
                        email: cv.email,
                        ...analysis
                    });
                }
            } catch (error) {
                console.error(`Error analyzing CV ${cv.id}:`, error);
                // Continue with other candidates
            }
        }

        // Sort by percentage descending
        results.sort((a, b) => b.percentage - a.percentage);

        res.status(200).json({
            success: true,
            matches: results,
            totalCandidates: cvs.length,
            matchedCandidates: results.length
        });

    } catch (error) {
        console.error('Matching error:', error);
        res.status(500).json({ 
            error: 'Internal server error during matching',
            details: error.message 
        });
    }
}
