class IntelligentCandidateMatcher {
    constructor() {
      // Weight factors for different sections of a profile
      this.sectionWeights = {
        jobTitle: 1.0,
        summary: 0.9,
        primarySkills: 0.8,
        currentRole: 0.8,
        recentExperience: 0.7,
        previousRoles: 0.6,
        additionalSkills: 0.4,
        education: 0.3,
        certifications: 0.5
      };
  
      // Proficiency level weights
      this.proficiencyWeights = {
        expert: 1.0,
        advanced: 0.85,
        intermediate: 0.6,
        beginner: 0.4,
        familiar: 0.3,
        basic: 0.2
      };
  
      // Context intensity modifiers
      this.contextModifiers = {
        primary: 1.0,
        main: 0.95,
        specialized: 0.9,
        extensive: 0.85,
        some: 0.4,
        basic: 0.3,
        transitioning: 0.6,
        learning: 0.3
      };
    }
  
    /**
     * Parse candidate profile and extract structured skill data
     */
    parseProfile(profile) {
      const sections = {
        jobTitle: profile.jobTitle || '',
        summary: profile.summary || '',
        primarySkills: profile.primarySkills || [],
        currentRole: profile.currentRole || {},
        recentExperience: profile.recentExperience || [],
        previousRoles: profile.previousRoles || [],
        additionalSkills: profile.additionalSkills || [],
        education: profile.education || [],
        certifications: profile.certifications || []
      };
  
      return this.extractSkillsFromSections(sections);
    }
  
    /**
     * Extract skills with weights from different profile sections
     */
    extractSkillsFromSections(sections) {
      const skillMap = new Map();
  
      // Process each section with appropriate weights
      Object.entries(sections).forEach(([sectionName, content]) => {
        const sectionWeight = this.sectionWeights[sectionName];
        const skills = this.extractSkillsFromContent(content, sectionName);
        
        skills.forEach(skill => {
          const key = skill.name.toLowerCase();
          if (!skillMap.has(key)) {
            skillMap.set(key, {
              name: skill.name,
              totalWeight: 0,
              sources: [],
              maxProficiency: 0,
              yearsExperience: 0
            });
          }
  
          const existing = skillMap.get(key);
          existing.totalWeight += skill.weight * sectionWeight;
          existing.sources.push({
            section: sectionName,
            context: skill.context,
            weight: skill.weight * sectionWeight
          });
          existing.maxProficiency = Math.max(existing.maxProficiency, skill.proficiency);
          existing.yearsExperience = Math.max(existing.yearsExperience, skill.yearsExperience || 0);
        });
      });
  
      return skillMap;
    }
  
    /**
     * Extract skills from content with context analysis
     */
    extractSkillsFromContent(content, sectionName) {
      const skills = [];
      
      if (typeof content === 'string') {
        skills.push(...this.analyzeTextForSkills(content, sectionName));
      } else if (Array.isArray(content)) {
        content.forEach(item => {
          if (typeof item === 'string') {
            skills.push(...this.analyzeTextForSkills(item, sectionName));
          } else if (typeof item === 'object') {
            skills.push(...this.analyzeObjectForSkills(item, sectionName));
          }
        });
      } else if (typeof content === 'object' && content !== null) {
        skills.push(...this.analyzeObjectForSkills(content, sectionName));
      }
  
      return skills;
    }
  
    /**
     * Analyze text content for skills with context
     */
    analyzeTextForSkills(text, sectionName) {
      const skills = [];
      const words = text.toLowerCase().split(/\s+/);
      
      // Common technology skills (extend this list based on your domain)
      const skillKeywords = [
        'javascript', 'python', 'java', 'react', 'node.js', 'angular', 'vue',
        'backend', 'frontend', 'fullstack', 'full-stack', 'full stack', 'devops', 'aws',
        'docker', 'kubernetes', 'sql', 'mongodb', 'postgresql', 'redis',
        'machine learning', 'ai', 'data science', 'analytics'
      ];
  
      skillKeywords.forEach(skill => {
        if (text.toLowerCase().includes(skill)) {
          const context = this.extractContext(text, skill);
          const proficiency = this.determineProficiency(context);
          const yearsExp = this.extractYearsExperience(context);
          const contextModifier = this.getContextModifier(context);
  
          skills.push({
            name: skill,
            weight: contextModifier,
            context: context,
            proficiency: proficiency,
            yearsExperience: yearsExp
          });
        }
      });
  
      return skills;
    }
  
    /**
     * Analyze object (like job experience) for skills
     */
    analyzeObjectForSkills(obj, sectionName) {
      const skills = [];
      const text = JSON.stringify(obj).toLowerCase();
      
      // Extract years of experience if available
      const yearsExp = obj.yearsExperience || obj.duration || 0;
      const isCurrentRole = obj.current === true || sectionName === 'currentRole';
      
      // Boost weight for current roles
      const roleMultiplier = isCurrentRole ? 1.2 : 1.0;
      
      return this.analyzeTextForSkills(text, sectionName).map(skill => ({
        ...skill,
        weight: skill.weight * roleMultiplier,
        yearsExperience: Math.max(skill.yearsExperience, yearsExp)
      }));
    }
  
    /**
     * Extract context around a skill mention
     */
    extractContext(text, skill) {
      const skillIndex = text.toLowerCase().indexOf(skill.toLowerCase());
      if (skillIndex === -1) return text;
      
      const start = Math.max(0, skillIndex - 50);
      const end = Math.min(text.length, skillIndex + skill.length + 50);
      return text.substring(start, end);
    }
  
    /**
     * Determine proficiency level from context
     */
    determineProficiency(context) {
      const proficiencyKeywords = {
        expert: ['expert', 'senior', 'lead', 'architect', 'specialist'],
        advanced: ['advanced', 'proficient', 'skilled', 'experienced'],
        intermediate: ['intermediate', 'competent', 'working knowledge'],
        beginner: ['beginner', 'junior', 'entry-level', 'trainee'],
        familiar: ['familiar', 'exposure', 'some experience'],
        basic: ['basic', 'fundamental', 'introductory']
      };
  
      for (const [level, keywords] of Object.entries(proficiencyKeywords)) {
        if (keywords.some(keyword => context.toLowerCase().includes(keyword))) {
          return this.proficiencyWeights[level];
        }
      }
  
      return this.proficiencyWeights.intermediate; // Default
    }
  
    /**
     * Extract years of experience from context
     */
    extractYearsExperience(context) {
      const yearMatches = context.match(/(\d+)\s*(?:years?|yrs?)/i);
      return yearMatches ? parseInt(yearMatches[1]) : 0;
    }
  
    /**
     * Get context modifier based on qualifying words
     */
    getContextModifier(context) {
      for (const [modifier, weight] of Object.entries(this.contextModifiers)) {
        if (context.toLowerCase().includes(modifier)) {
          return weight;
        }
      }
      return 0.4; // Lower default relevance to avoid inflated base scores
    }

    /**
     * Calculate match score for a candidate against a job requirement
     */
    calculateMatchScore(candidateSkills, jobRequirements) {
      let totalScore = 0;
      let maxPossibleScore = 0;
      const skillBreakdown = {};

      // Role-level keywords that should align with primary contexts
      const roleKeywords = new Set(['fullstack', 'full-stack', 'full stack', 'backend', 'frontend', 'devops', 'data science', 'machine learning']);

      jobRequirements.forEach(requirement => {
        const reqSkill = requirement.skill.toLowerCase();
        const reqImportance = requirement.importance || 1.0; // importance weight
        const reqMinLevel = requirement.minLevel || 0.5; // minimum proficiency

        maxPossibleScore += reqImportance;

        if (candidateSkills.has(reqSkill)) {
          const candidateSkill = candidateSkills.get(reqSkill);

          const primarySections = new Set(['jobTitle', 'currentRole', 'primarySkills', 'summary']);
          const appearsInPrimary = (candidateSkill.sources || []).some(s => primarySections.has(s.section));

          // Diminishing returns so multiple weak mentions don't max out
          const baseFromWeight = 1 - Math.exp(-Math.max(0, candidateSkill.totalWeight));
          const proficiencyMultiplier = candidateSkill.maxProficiency >= reqMinLevel ? 1.0 : 0.7;
          const expBonus = Math.min(Math.max(candidateSkill.yearsExperience || 0, 0) * 0.02, 0.10);

          let skillScore = baseFromWeight * proficiencyMultiplier + expBonus;

          // Cap non-primary role keywords lower to avoid 100% on side skills
          if (roleKeywords.has(reqSkill) && !appearsInPrimary) {
            skillScore = Math.min(skillScore, 0.6);
          } else if (!roleKeywords.has(reqSkill) && !appearsInPrimary) {
            // Other skills not in primary context capped below perfect
            skillScore = Math.min(skillScore, 0.7);
          }

          skillScore = Math.min(skillScore, 1.0) * reqImportance;
          totalScore += skillScore;

          skillBreakdown[requirement.skill] = {
            score: skillScore,
            maxScore: reqImportance,
            percentage: Math.round((skillScore / reqImportance) * 100),
            candidateWeight: candidateSkill.totalWeight,
            proficiency: candidateSkill.maxProficiency,
            sources: candidateSkill.sources
          };

          if (process.env.MATCH_DEBUG) {
            console.log('[MATCH_DEBUG] req=%s weight=%.2f minLev=%.2f | candWeight=%.2f prof=%.2f years=%d primary=%s -> score=%.2f/%s',
              requirement.skill,
              reqImportance,
              reqMinLevel,
              candidateSkill.totalWeight,
              candidateSkill.maxProficiency,
              candidateSkill.yearsExperience || 0,
              appearsInPrimary,
              skillScore,
              reqImportance
            );
          }
        } else {
          skillBreakdown[requirement.skill] = {
            score: 0,
            maxScore: reqImportance,
            percentage: 0,
            candidateWeight: 0,
            proficiency: 0,
            sources: []
          };

          if (process.env.MATCH_DEBUG) {
            console.log('[MATCH_DEBUG] req=%s not found in candidate -> score=0/%s', requirement.skill, reqImportance);
          }
        }
      });

      let overallScore = maxPossibleScore > 0 ? (totalScore / maxPossibleScore) : 0;

      // Overall specialty alignment: if a role keyword is requested but does not
      // appear in primary sections for the candidate, apply an overall cap so
      // the candidate can't reach 100% solely via secondary mentions.
      const normalize = s => (s || '').toLowerCase().replace(/[\s-]+/g, '');
      const requestedRoleKeys = jobRequirements
        .map(r => r.skill)
        .filter(s => roleKeywords.has(s.toLowerCase()));

      if (requestedRoleKeys.length > 0) {
        const hasPrimaryRole = requestedRoleKeys.some(req => {
          const reqNorm = normalize(req);
          for (const [key, data] of candidateSkills.entries()) {
            if (normalize(key) === reqNorm) {
              const primarySections = new Set(['jobTitle', 'currentRole', 'primarySkills', 'summary']);
              return (data.sources || []).some(s => primarySections.has(s.section));
            }
          }
          return false;
        });

        if (!hasPrimaryRole) {
          // multiplicative reduction to avoid clustering around ~85%
          overallScore = 0.9 * overallScore;
          // and cap absolute ceiling to 0.9
          overallScore = Math.min(overallScore, 0.9);

          if (process.env.MATCH_DEBUG) {
            console.log('[MATCH_DEBUG] overall specialty cap applied; requested roles=%j finalOverall=%.2f', Array.from(requestedRoleKeys), overallScore);
          }
        }
      }

      // Additional primary coverage cap: if fewer than 70% of requested skills appear in
      // primary sections, cap the overall score to avoid inflated near-100 matches.
      if (jobRequirements.length > 0) {
        const primarySections = new Set(['jobTitle', 'currentRole', 'primarySkills', 'summary']);
        let primaryHits = 0;
        jobRequirements.forEach(r => {
          const key = (r.skill || '').toLowerCase();
          if (candidateSkills.has(key)) {
            const data = candidateSkills.get(key);
            if ((data.sources || []).some(s => primarySections.has(s.section))) {
              primaryHits += 1;
            }
          }
        });
        const coverage = primaryHits / jobRequirements.length;
        if (coverage < 0.7) {
          overallScore = Math.min(overallScore, 0.92);
          if (process.env.MATCH_DEBUG) {
            console.log('[MATCH_DEBUG] primary coverage cap applied; coverage=%.2f overall=%.2f', coverage, overallScore);
          }
        }
      }

      // Avoid 100% unless truly perfect in primary context for all requested skills
      const primarySectionsFinal = new Set(['jobTitle', 'currentRole', 'primarySkills', 'summary']);
      const allReqPrimaryPerfect = jobRequirements.length > 0 && jobRequirements.every(r => {
        const key = (r.skill || '').toLowerCase();
        const breakdown = skillBreakdown[r.skill];
        if (!breakdown || breakdown.percentage !== 100) return false;
        if (!candidateSkills.has(key)) return false;
        const data = candidateSkills.get(key);
        return (data.sources || []).some(s => primarySectionsFinal.has(s.section));
      });

      let finalPercentage = Math.floor(overallScore * 100);
      if (!allReqPrimaryPerfect) {
        finalPercentage = Math.min(finalPercentage, 98);
      }

      // If the requirement set is very small (e.g., only a role keyword like "full stack"),
      // prevent showing 100% by capping to 95% unless there are at least 3 distinct requirements
      if (jobRequirements.length < 3) {
        finalPercentage = Math.min(finalPercentage, 95);
      }

      return {
        overallScore: finalPercentage,
        skillBreakdown,
        totalScore,
        maxPossibleScore
      };
    }

    /**
     * Main method to match candidates against job requirements
     */
    matchCandidates(candidates, jobRequirements) {
      return candidates
        .map(candidate => {
          const candidateSkills = this.parseProfile(candidate.profile);
          const matchResult = this.calculateMatchScore(candidateSkills, jobRequirements);
          return {
            candidate,
            matchScore: matchResult.overallScore,
            skillBreakdown: matchResult.skillBreakdown,
            details: matchResult
          };
        })
        .sort((a, b) => b.matchScore - a.matchScore);
    }
  }

  // Export matcher for server usage
  module.exports = { IntelligentCandidateMatcher };