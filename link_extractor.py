import re
import os
import json
import sys
from docx import Document
import fitz  # PyMuPDF

# Regex patterns for LinkedIn and GitHub profiles
linkedin_pattern = re.compile(r"https?://(www\.)?linkedin\.com/in/[A-Za-z0-9\-_]+/?$")
github_pattern = re.compile(r"https?://(www\.)?github\.com/[A-Za-z0-9\-_]+/?$")

def filter_profiles(links):
    """Extract only personal LinkedIn and GitHub profiles"""
    profiles = {"linkedin": None, "github": None}
    for link in links:
        link = link.strip().split("?")[0].rstrip("/")  # Clean trailing ? and /
        if linkedin_pattern.match(link):
            profiles["linkedin"] = link
        elif github_pattern.match(link):
            profiles["github"] = link
    return profiles

def extract_links_from_docx(path):
    """Extract links from DOCX file"""
    doc = Document(path)
    links = []

    # Extract plain URLs from text
    full_text = "\n".join([p.text for p in doc.paragraphs])
    links += re.findall(r"(https?://[^\s]+)", full_text)

    # Extract hyperlinks
    for rel in doc.part.rels.values():
        if "hyperlink" in rel.reltype:
            links.append(rel.target_ref)

    return filter_profiles(links)

def extract_links_from_pdf(path):
    """Extract links from PDF file"""
    doc = fitz.open(path)
    links = []

    # Extract plain URLs from text
    text = ""
    for page in doc:
        text += page.get_text()
    links += re.findall(r"(https?://[^\s]+)", text)

    # Extract hyperlinks
    for page in doc:
        for link in page.get_links():
            uri = link.get("uri", "")
            if uri:
                links.append(uri)

    doc.close()
    return filter_profiles(links)

def extract_from_folder(folder_path):
    """Extract links from all CV files in folder"""
    results = []

    if not os.path.exists(folder_path):
        print(f"Error: Folder {folder_path} does not exist")
        return results

    for filename in os.listdir(folder_path):
        file_path = os.path.join(folder_path, filename)
        
        if not os.path.isfile(file_path):
            continue

        try:
            if filename.lower().endswith(".docx"):
                profiles = extract_links_from_docx(file_path)
            elif filename.lower().endswith(".pdf"):
                profiles = extract_links_from_pdf(file_path)
            else:
                continue  # Skip other file types

            results.append({
                "filename": filename,
                "linkedin": profiles["linkedin"],
                "github": profiles["github"]
            })
        except Exception as e:
            print(f"Error processing {filename}: {str(e)}")
            results.append({
                "filename": filename,
                "linkedin": None,
                "github": None,
                "error": str(e)
            })

    return results

def extract_from_single_file(file_path):
    """Extract links from a single file"""
    if not os.path.exists(file_path):
        return {"linkedin": None, "github": None, "error": "File not found"}
    
    try:
        filename = os.path.basename(file_path)
        if filename.lower().endswith(".docx"):
            profiles = extract_links_from_docx(file_path)
        elif filename.lower().endswith(".pdf"):
            profiles = extract_links_from_pdf(file_path)
        else:
            return {"linkedin": None, "github": None, "error": "Unsupported file type"}
        
        return {
            "filename": filename,
            "linkedin": profiles["linkedin"],
            "github": profiles["github"]
        }
    except Exception as e:
        return {
            "filename": os.path.basename(file_path),
            "linkedin": None,
            "github": None,
            "error": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python link_extractor.py <folder_path_or_file_path>")
        sys.exit(1)
    
    path = sys.argv[1]
    
    if os.path.isdir(path):
        # Process folder
        results = extract_from_folder(path)
        print(json.dumps(results, indent=2))
    elif os.path.isfile(path):
        # Process single file
        result = extract_from_single_file(path)
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps({"error": "Path does not exist"}, indent=2))
