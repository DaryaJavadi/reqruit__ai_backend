const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

class CVExcelExporter {
    constructor() {
        this.workbook = new ExcelJS.Workbook();
    }

    async exportToExcel(cvData, outputPath = null) {
        try {
            // Create worksheet
            const worksheet = this.workbook.addWorksheet('CV Analysis Results');

            // Define columns
            const columns = [
                { header: 'Name', key: 'name', width: 20 },
                { header: 'Email', key: 'email', width: 25 },
                { header: 'Phone', key: 'phone', width: 15 },
                { header: 'LinkedIn', key: 'linkedin', width: 40 },
                { header: 'GitHub', key: 'github', width: 40 },
                { header: 'Website', key: 'website', width: 30 },
                { header: 'Professional Specialty', key: 'professional_specialty', width: 25 },
                { header: 'Total Experience (Years)', key: 'total_years_experience', width: 20 },
                { header: 'Primary Experience (Years)', key: 'primary_experience_years', width: 20 },
                { header: 'Highest Degree', key: 'highest_university_degree', width: 25 },
                { header: 'University', key: 'university_name', width: 30 },
                { header: 'Technical Skills', key: 'technical_skills', width: 40 },
                { header: 'Programming Languages', key: 'programming_languages', width: 30 },
                { header: 'Frameworks/Tools', key: 'frameworks_tools', width: 30 },
                { header: 'Soft Skills', key: 'soft_skills', width: 30 },
                { header: 'Languages', key: 'languages', width: 20 },
                { header: 'Certifications', key: 'certifications', width: 40 },
                { header: 'Summary', key: 'summary', width: 50 },
                { header: 'Original Language', key: 'original_language', width: 15 },
                { header: 'Filename', key: 'filename', width: 25 }
            ];

            worksheet.columns = columns;

            // Style the header row
            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '366092' }
            };
            headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

            // Add data rows
            if (Array.isArray(cvData)) {
                cvData.forEach((cv, index) => {
                    const rowData = this.formatCVForExcel(cv);
                    const row = worksheet.addRow(rowData);
                    
                    // Alternate row colors
                    if (index % 2 === 1) {
                        row.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: 'F2F2F2' }
                        };
                    }
                });
            } else {
                // Single CV
                const rowData = this.formatCVForExcel(cvData);
                worksheet.addRow(rowData);
            }

            // Auto-fit columns
            worksheet.columns.forEach(column => {
                column.width = Math.max(column.width, 15);
            });

            // Add borders to all cells
            worksheet.eachRow((row, rowNumber) => {
                row.eachCell((cell) => {
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' }
                    };
                });
            });

            // Generate filename if not provided
            if (!outputPath) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                outputPath = path.join(__dirname, `cv_analysis_${timestamp}.xlsx`);
            }

            // Save the file
            await this.workbook.xlsx.writeFile(outputPath);
            console.log(`✅ Excel file exported to: ${outputPath}`);
            
            return {
                success: true,
                filePath: outputPath,
                message: 'Excel file exported successfully'
            };

        } catch (error) {
            console.error('❌ Excel export error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    formatCVForExcel(cv) {
        // Helper function to format arrays as comma-separated strings
        const formatArray = (arr) => {
            if (!arr) return '';
            if (Array.isArray(arr)) {
                return arr.filter(Boolean).join(', ');
            }
            return String(arr);
        };

        // Helper function to format skills object
        const formatSkills = (skills, key) => {
            if (!skills || !skills[key]) return '';
            return formatArray(skills[key]);
        };

        return {
            name: cv.name || '',
            email: cv.email || '',
            phone: cv.phone || '',
            linkedin: cv.linkedin || '',
            github: cv.github || '',
            website: cv.website || '',
            professional_specialty: cv.professional_specialty || '',
            total_years_experience: cv.total_years_experience || 0,
            primary_experience_years: cv.primary_experience_years || 0,
            highest_university_degree: cv.highest_university_degree || '',
            university_name: cv.university_name || '',
            technical_skills: formatSkills(cv.skills, 'technical_skills'),
            programming_languages: formatSkills(cv.skills, 'programming_languages'),
            frameworks_tools: formatSkills(cv.skills, 'frameworks_tools'),
            soft_skills: formatSkills(cv.skills, 'soft_skills'),
            languages: formatSkills(cv.skills, 'languages'),
            certifications: formatSkills(cv.skills, 'certifications'),
            summary: cv.summary || '',
            original_language: cv.original_language || '',
            filename: cv.filename || ''
        };
    }

    async exportMatchingResults(matchingData, outputPath = null) {
        try {
            const worksheet = this.workbook.addWorksheet('CV Matching Results');

            const columns = [
                { header: 'Rank', key: 'rank', width: 8 },
                { header: 'Name', key: 'name', width: 20 },
                { header: 'Match Score', key: 'score', width: 12 },
                { header: 'Match Percentage', key: 'percentage', width: 15 },
                { header: 'Professional Specialty', key: 'professional_specialty', width: 25 },
                { header: 'Experience (Years)', key: 'total_years_experience', width: 15 },
                { header: 'LinkedIn', key: 'linkedin', width: 40 },
                { header: 'GitHub', key: 'github', width: 40 },
                { header: 'Email', key: 'email', width: 25 },
                { header: 'Matched Skills', key: 'matched_skills', width: 50 },
                { header: 'Reasoning', key: 'reasoning', width: 60 },
                { header: 'Filename', key: 'filename', width: 25 }
            ];

            worksheet.columns = columns;

            // Style header
            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '366092' }
            };

            // Add data
            matchingData.forEach((match, index) => {
                const row = worksheet.addRow({
                    rank: index + 1,
                    name: match.name || '',
                    score: match.score || 0,
                    percentage: match.percentage || 0,
                    professional_specialty: match.professional_specialty || '',
                    total_years_experience: match.total_years_experience || 0,
                    linkedin: match.linkedin || '',
                    github: match.github || '',
                    email: match.email || '',
                    matched_skills: Array.isArray(match.matchedSkills) ? match.matchedSkills.join(', ') : '',
                    reasoning: match.reasoning || '',
                    filename: match.filename || ''
                });

                // Color code based on score
                if (match.percentage >= 80) {
                    row.getCell('percentage').fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: '90EE90' } // Light green
                    };
                } else if (match.percentage >= 60) {
                    row.getCell('percentage').fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFFF99' } // Light yellow
                    };
                } else if (match.percentage < 40) {
                    row.getCell('percentage').fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFB6C1' } // Light red
                    };
                }
            });

            if (!outputPath) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                outputPath = path.join(__dirname, `cv_matching_results_${timestamp}.xlsx`);
            }

            await this.workbook.xlsx.writeFile(outputPath);
            console.log(`✅ Matching results exported to: ${outputPath}`);
            
            return {
                success: true,
                filePath: outputPath,
                message: 'Matching results exported successfully'
            };

        } catch (error) {
            console.error('❌ Excel export error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = CVExcelExporter;
